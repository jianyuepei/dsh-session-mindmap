/**
 * Token budgeting and transcript assembly.
 *
 * Pure module: deterministic, clock-free, unit-testable. The estimate is a
 * deliberate over-approximation for CJK-heavy sessions, because exceeding the
 * provider context costs a failed run while staying under it only costs a
 * slightly thinner transcript.
 *
 * @module dsh-session-mindmap/budget
 */

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/**
 * Rough token estimate: one token per CJK character, one per four others.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

/** Character budgets applied when rendering one turn into the transcript. */
const DEFAULT_BUDGET = Object.freeze({ userChars: 800, assistantChars: 1200 });

/** Cost of one turn under the given character budgets. */
export function turnCost(turn, budget = DEFAULT_BUDGET) {
  const user = String(turn.user ?? "").slice(0, budget.userChars);
  const assistant = String(turn.assistant ?? "").slice(0, budget.assistantChars);
  const overhead = 12 + (turn.tools?.length ?? 0) * 4 + (turn.files?.length ?? 0) * 3;
  return estimateTokens(user) + estimateTokens(assistant) + overhead;
}

/**
 * Render one turn as the model-facing transcript fragment.
 * @param {object} turn
 * @param {{userChars:number, assistantChars:number}} budget
 * @returns {string}
 */
export function renderTurn(turn, budget = DEFAULT_BUDGET) {
  // Blocks are numbered by transcript position: the DSH turn number repeats
  // whenever one turn had to be split, and the model needs an unambiguous order.
  const label = Number.isFinite(turn.index) ? turn.index : turn.turn;
  const turnNote = Number.isFinite(turn.turn) && turn.turn !== label ? ` · turn ${turn.turn}` : "";
  const lines = [`## 第 ${label} 段 · seq ${turn.firstSeq}-${turn.lastSeq}${turnNote}`];
  const user = String(turn.user ?? "").slice(0, budget.userChars);
  const assistant = String(turn.assistant ?? "").slice(0, budget.assistantChars);
  if (user) lines.push(`用户: ${user}`);
  if (assistant) lines.push(`助手: ${assistant}`);
  if (turn.tools?.length) lines.push(`工具: ${turn.tools.join(", ")}`);
  if (turn.files?.length) lines.push(`涉及文件: ${turn.files.join(", ")}`);
  if (turn.errors?.length) lines.push(`失败调用: ${turn.errors.join("; ")}`);
  return lines.join("\n");
}

/** Render a group of turns into one transcript string. */
export function renderTranscript(turns, budget = DEFAULT_BUDGET) {
  return turns.map((turn) => renderTurn(turn, budget)).join("\n\n");
}

/** Character-budget scaling steps tried while squeezing an oversized session. */
const SQUEEZE_FACTORS = [1, 0.6, 0.4, 0.25, 0.15];

/** Split an array into at most `max` contiguous groups of near-equal size. */
function evenGroups(items, max) {
  const groups = [];
  const size = Math.ceil(items.length / max);
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

/**
 * @typedef {object} SegmentPlan
 * @property {object[][]} groups - turn groups, one per LLM map call.
 * @property {{userChars:number, assistantChars:number}} budget - budgets for `renderTranscript`.
 * @property {number} estimatedTokens - total cost under `budget`.
 * @property {boolean} squeezed - whether per-turn text had to be reduced.
 */

/**
 * Decide how many LLM calls the session needs and how much text each carries.
 *
 * Order of preference: one call inside budget → smaller per-turn text inside a
 * larger total budget → greedy packing into at most `maxBlocks` calls → even
 * distribution across exactly `maxBlocks` calls (each transcript then stays
 * near the per-call budget because the text was already squeezed).
 *
 * @param {object[]} turns
 * @param {object} options
 * @param {number} options.maxInputTokens - transcript budget for one call.
 * @param {number} options.maxBlocks - hard cap on map calls.
 * @returns {SegmentPlan}
 */
export function planSegments(turns, options) {
  const maxInputTokens = Math.max(500, options?.maxInputTokens ?? 24000);
  const maxBlocks = Math.max(1, options?.maxBlocks ?? 8);
  const list = Array.isArray(turns) ? turns : [];

  if (list.length === 0) {
    return { groups: [], budget: { ...DEFAULT_BUDGET }, estimatedTokens: 0, squeezed: false };
  }

  const total = (budget) => list.reduce((sum, turn) => sum + turnCost(turn, budget), 0);

  if (total(DEFAULT_BUDGET) <= maxInputTokens || maxBlocks === 1) {
    return {
      groups: [list],
      budget: { ...DEFAULT_BUDGET },
      estimatedTokens: total(DEFAULT_BUDGET),
      squeezed: false,
    };
  }

  // Try progressively tighter per-turn text until the whole session fits into
  // the total budget the allowed number of calls provides.
  let budget = { ...DEFAULT_BUDGET };
  let squeezed = false;
  for (const factor of SQUEEZE_FACTORS) {
    const candidate = {
      userChars: Math.max(120, Math.round(DEFAULT_BUDGET.userChars * factor)),
      assistantChars: Math.max(180, Math.round(DEFAULT_BUDGET.assistantChars * factor)),
    };
    if (factor < 1) squeezed = true;
    if (total(candidate) <= maxInputTokens * maxBlocks) {
      budget = candidate;
      break;
    }
    budget = candidate;
  }

  // Greedy packing under the per-call budget.
  const groups = [];
  let bucket = [];
  let bucketCost = 0;
  for (const turn of list) {
    const cost = turnCost(turn, budget);
    if (bucket.length > 0 && bucketCost + cost > maxInputTokens) {
      groups.push(bucket);
      bucket = [];
      bucketCost = 0;
    }
    bucket.push(turn);
    bucketCost += cost;
  }
  if (bucket.length > 0) groups.push(bucket);

  const finalGroups = groups.length <= maxBlocks ? groups : evenGroups(list, maxBlocks);
  return {
    groups: finalGroups,
    budget,
    estimatedTokens: finalGroups.reduce(
      (sum, group) => sum + group.reduce((inner, turn) => inner + turnCost(turn, budget), 0),
      0,
    ),
    squeezed,
  };
}
