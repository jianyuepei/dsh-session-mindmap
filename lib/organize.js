/**
 * LLM orchestration: turn blocks → validated mind map.
 *
 * The model call is injected as `callModel`, so the whole pipeline (single
 * call, map-reduce for long sessions, retry, failure) is testable without a
 * provider and without touching real session content.
 *
 * @module dsh-session-mindmap/organize
 */

import { planSegments, renderTranscript } from "./budget.js";
import { DEFAULT_KINDS, KIND_LABELS, extractJsonObject, normalizeMindMap } from "./schema.js";

/** Minimal JSON-shape contract handed to the model. */
const SHAPE_HINT = `{
  "title": "整个会话的一句话主题",
  "root": {
    "label": "核心主题",
    "kind": "topic",
    "detail": "可选的一句话概述",
    "refs": { "seq": [12, 48] },
    "children": [
      { "label": "子主题", "kind": "topic", "detail": "可选", "refs": { "seq": [31] }, "children": [] }
    ]
  }
}`;

/**
 * Node budgets for one answer.
 *
 * These are bounded by `maxOutputTokens`, not by taste: a node costs roughly
 * (label + detail + kind + refs) characters, and a budget that does not fit the
 * output limit gets the answer truncated mid-JSON — which is exactly how
 * `session_mindmap` failed once the rubric below started producing more nodes.
 * `tests/organize.test.js` asserts the worst case still fits.
 */
export const NODE_BUDGET = Object.freeze({ map: 35, merge: 45, mergeDetailChars: 60 });

/**
 * System prompt for one generation call.
 * @param {object} options
 * @param {string[]} options.kinds - enabled node kinds.
 * @param {"zh"|"en"} options.language
 * @param {number} [options.nodeBudget] - node cap for this answer.
 * @param {number} [options.detailChars] - detail cap for this answer.
 * @returns {string}
 */
export function buildSystemPrompt({ kinds, language, nodeBudget = NODE_BUDGET.map, detailChars = 120 }) {
  const labels = KIND_LABELS[language === "en" ? "en" : "zh"];
  const kindLines = kinds.map((kind) => `- \`${kind}\`（${labels[kind]}）`).join("\n");
  const outputLanguage = language === "en" ? "英语" : "中文";
  return [
    "你是一个会话复盘助手。你会读到一段按轮次整理的会话记录，需要把它整理成一张脑图（思维导图）。",
    "",
    "硬性要求：",
    `1. 只输出一个 JSON 对象，不要有任何解释文字，不要用 Markdown 代码块包裹。`,
    `2. JSON 形状必须严格如下：\n${SHAPE_HINT}`,
    `3. 所有 label / detail / title 用${outputLanguage}书写；label 不超过 40 字，detail 不超过 ${detailChars} 字。`,
    "4. 只允许使用这些 kind：",
    kindLines,
    "5. 只写会话记录里真实出现过的内容，禁止脑补、禁止补充你自己的建议。",
    `6. 层级不要超过 4 层；节点总数**不要超过 ${nodeBudget} 个**；同一父节点下不要有重复 label。` +
      "宁可少写几个节点，也**绝不能让 JSON 写到一半就断掉**——不完整的 JSON 会让整次生成失败。",
    "7. 尽量为每个节点填 refs.seq，写它依据的轮次 seq 区间里的任一 seq；没有依据就留空数组。",
    "8. 如果某一类信息在会话里不存在，就不要造节点。",
    kinds.includes("file")
      ? "9. 会话里读写过的文件放进 `file` 节点，挂在对应话题下面。"
      : "9. 本次不需要文件维度：不要为“涉及的文件”“改动过的文件”之类单独造节点。",
    "",
    "组织建议：root 是会话主题；一级节点是几个主要话题；把结论、决策（含理由）、待办、未决问题挂在对应话题下面。",
    ...rubric(kinds),
  ].join("\n");
}

/**
 * Per-kind judgement rules, appended when the kind is enabled.
 *
 * A "be thorough" instruction does not move a model; a definition plus a
 * self-check does. The todo and question rules exist because a real run
 * produced 32 nodes with no todo at all on a session that clearly ended with
 * unfinished work.
 */
function rubric(kinds) {
  const has = (kind) => kinds.includes(kind);
  const rules = [];
  if (has("conclusion")) {
    rules.push("- conclusion：会话里得出的、有依据的判断。谁说的不重要，有结论就算。");
  }
  if (has("decision")) {
    rules.push("- decision：在多个选项之间做过选择，必须把**理由**写进 detail。");
  }
  if (has("todo")) {
    rules.push(
      "- todo：任何**还没做完**的事——下一步要做什么、待验证的假设、答应了但还没执行的动作，" +
        "哪怕只在对话里一句话带过。只有会话结束时确实没有任何未完成事项，才可以没有 todo 节点。",
    );
  }
  if (has("question")) {
    rules.push("- question：被明确悬置、没有定论的问题（“先放着”“以后再定”“还不确定”）。");
  }
  if (rules.length === 0) return [];
  const checks = [];
  if (has("todo")) checks.push("没做完的事");
  if (has("question")) checks.push("没定的问题");
  return [
    "",
    "判定标准（漏掉这些是最常见的失误）：",
    ...rules,
    ...(checks.length > 0
      ? [
          `自检：读完以后问自己“这场会话最后有没有留下${checks.join("、")}？”如果有，` +
            "而你的 JSON 里没有对应的节点，那就是漏了，补上再输出。",
        ]
      : []),
  ];
}

/**
 * User prompt for one generation call.
 * @param {object} options
 * @param {string} options.sessionTitle
 * @param {string} options.transcript
 * @param {number} [options.part]
 * @param {number} [options.total]
 * @param {string} [options.focus]
 * @returns {string}
 */
export function buildUserPrompt({ sessionTitle, transcript, part, total, focus }) {
  const lines = [`会话标题：${sessionTitle || "（无标题）"}`];
  if (focus) lines.push(`抽取重点：只围绕「${focus}」整理，其它内容可以省略。`);
  if (part && total) {
    lines.push(
      `这是会话的第 ${part}/${total} 段，请只基于这一段产出部分脑图；后续会与其它段合并，不要试图概括没读到的内容。`,
    );
  }
  lines.push("", "会话记录：", transcript);
  return lines.join("\n");
}

/**
 * Prompt that merges partial mind maps into the final one.
 * @param {object} options
 * @param {string} options.sessionTitle
 * @param {string} options.partials - serialised partial maps.
 * @param {"zh"|"en"} options.language
 * @param {string} [options.focus]
 * @returns {string}
 */
export function buildMergePrompt({ sessionTitle, partials, language, focus }) {
  return [
    `会话标题：${sessionTitle || "（无标题）"}`,
    focus ? `抽取重点：只围绕「${focus}」整理。` : "",
    "下面是同一场会话按时间顺序切分后、分段产出的部分脑图（JSON）。请把它们合并成一张完整的脑图：合并重复话题，按时间顺序排列，保留最有信息量的细节，去掉重复节点。",
    "合并时**不要丢话题**：每一段里出现过的不同话题都要在结果里有位置，哪怕它只值一个节点。",
    "保留各节点原有的 kind 和 refs.seq。",
    "仍然只输出一个 JSON 对象，形状与分段脑图完全一致，不要输出解释文字。",
    `如果某段的部分脑图是空对象或与主题无关，忽略它。语言继续使用${language === "en" ? "英语" : "中文"}。`,
    "",
    partials,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Consume one streamed call into final text.
 *
 * @param {(request: object) => AsyncIterable<object>} stream - `ctx.llm.stream`.
 * @param {object} request - GenerateOptions minus the stream function.
 * @returns {Promise<{text: string, usage: object|null, finish: object|null}>}
 */
export async function collectStream(stream, request) {
  let text = "";
  let usage = null;
  let finish = null;
  for await (const chunk of stream(request)) {
    if (!chunk || typeof chunk !== "object") continue;
    switch (chunk.type) {
      case "text-delta":
        text += chunk.text ?? "";
        break;
      case "usage":
        usage = chunk.usage ?? usage;
        break;
      case "finish":
        finish = chunk.reason ?? null;
        break;
      default:
        break;
    }
  }
  if (finish && (finish.kind === "error" || finish.kind === "aborted")) {
    const failure = finish.failure ?? {};
    const detail = failure.message ?? "模型调用未完成";
    throw new Error(`模型调用失败（${failure.code ?? finish.kind}）：${detail}`);
  }
  return { text, usage, finish };
}

/**
 * Why an answer was unusable, and what the retry should say about it.
 *
 * A generic "try again" repeats the same doomed request: when the answer was
 * cut off by the output limit, the retry has to ask for something smaller.
 */
function failureOf({ finish, parsed, map }) {
  if (finish?.kind === "max-tokens") return "truncated";
  if (!parsed) return "unparseable";
  if (!map) return "shape";
  return null;
}

const RETRY_NOTES = {
  truncated:
    "上一次的回答**太长被截断了**（达到输出上限）。这次请大幅压缩：节点总数不超过 20 个，detail 不超过 40 字，" +
    "优先保留最重要的内容，先保证 JSON 完整闭合。",
  shape:
    "上一次的 JSON 里没有可用的根节点。请严格按给定形状输出：root 必须带 label，子节点放在 children 数组里。",
  unparseable: "上一次的回答不是合法 JSON。请只输出 JSON 对象本体，不要代码块、不要解释文字。",
};

/** Short, safe excerpt of a model answer for an error message. */
function excerptOf(text, max = 160) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** Human description of a finish reason. */
function describeFinish(finish) {
  if (!finish) return "未知";
  if (finish.kind === "max-tokens") return "输出达到 maxOutputTokens，被截断";
  if (finish.kind === "stop") return "正常结束";
  return String(finish.kind);
}

/** One call: prompt in, parsed-and-normalised map out; `null` when unusable. */
async function callForMap(callModel, { system, user, options, retryNote, log }) {
  const messages = [user];
  if (retryNote) messages.push(retryNote);
  const { text, usage, finish } = await callModel({ system, user: messages.join("\n\n") });
  const parsed = extractJsonObject(text);
  const map = parsed ? normalizeMindMap(parsed, options) : null;
  const failure = failureOf({ finish, parsed, map });
  if (map && finish?.kind === "max-tokens") {
    // Salvaged from a cut-off answer: usable, but the tail is missing.
    log?.("模型输出达到上限被截断，已按完整部分解析（脑图可能略短）");
  }
  return {
    map,
    text,
    usage,
    finish,
    failure,
    error: failure ? RETRY_NOTES[failure] : null,
    excerpt: excerptOf(text),
  };
}

/**
 * Serialise partial maps for the merge call, bounded by a character budget.
 *
 * The merge input is itself a prompt, so it has to survive a session split into
 * many segments. Details are dropped before any truncation: losing a sentence of
 * colour costs less than losing a whole topic because the text ran out.
 *
 * @param {object[]} partials
 * @param {number} [maxChars]
 * @returns {string}
 */
export function serializePartials(partials, maxChars = MAX_MERGE_CHARS) {
  const render = (maps) =>
    maps.map((map, index) => `### 第 ${index + 1} 段\n${JSON.stringify(map)}`).join("\n\n");

  const full = render(partials);
  if (full.length <= maxChars) return full;

  const lean = render(partials.map(stripDetails));
  if (lean.length <= maxChars) return lean;

  return `${lean.slice(0, maxChars).trimEnd()}\n…（超出预算的部分已截断）`;
}

/** Merge budget in characters (roughly 20k tokens of CJK). */
const MAX_MERGE_CHARS = 60000;

/** Copy of a mind map without node details, depth-first. */
function stripDetails(map) {
  const walk = (node) => ({
    label: node.label,
    kind: node.kind,
    ...(node.refs?.seq?.length ? { refs: node.refs } : {}),
    ...(node.children?.length ? { children: node.children.map(walk) } : {}),
  });
  return { title: map.title, root: walk(map.root) };
}

/**
 * Produce the final mind map for one session.
 *
 * Cost bound: one call for a session inside the transcript budget, otherwise
 * one call per segment plus one merge call (`maxBlocks + 1`).
 *
 * @param {object} options
 * @param {(request: {system: string, user: string}) => Promise<{text: string, usage: object|null}>} options.callModel
 * @param {string} options.sessionTitle
 * @param {object[]} options.turns - `TurnBlock[]` from extract.
 * @param {object} options.config - resolved plugin config.
 * @param {string} [options.focus]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{map: object, calls: number, usage: object[], squeezed: boolean, segments: number}>}
 */
/** Actionable error for an answer that could not be used twice. */
function unusableAnswer(result) {
  const lines = [`模型两次都没有返回可用的脑图 JSON：${describeFinish(result.finish)}`];
  if (result.excerpt) lines.push(`模型输出开头：${result.excerpt}`);
  lines.push(
    result.failure === "truncated"
      ? "回答被输出长度截断了：调大 maxOutputTokens，或减少维度（kinds）、调小 maxNodes。"
      : "可尝试换模型、缩小范围（focus），或减少维度（kinds）。",
  );
  return new Error(lines.join("\n"));
}

/**
 * Produce the final mind map for one session.
 *
 * Cost bound: one call for a session inside the transcript budget, otherwise
 * one call per segment plus one merge call (`maxBlocks + 1`).
 */
export async function generateMindMap({ callModel, sessionTitle, turns, config, focus, log }) {
  const language = config.language === "en" ? "en" : "zh";
  const kinds =
    Array.isArray(config.kinds) && config.kinds.length > 0 ? config.kinds : [...DEFAULT_KINDS];
  const normalizeOptions = {
    kinds,
    maxNodes: config.maxNodes ?? 80,
    maxDepth: config.maxDepth ?? 4,
    title: sessionTitle,
  };
  const system = buildSystemPrompt({ kinds, language, nodeBudget: NODE_BUDGET.map });
  const mergeSystem = buildSystemPrompt({
    kinds,
    language,
    nodeBudget: NODE_BUDGET.merge,
    detailChars: NODE_BUDGET.mergeDetailChars,
  });
  const plan = planSegments(turns, {
    maxInputTokens: config.maxInputTokens ?? 24000,
    maxBlocks: config.maxBlocks ?? 8,
  });

  if (plan.groups.length === 0) {
    throw new Error("会话里没有可用于生成脑图的内容（没有用户消息或助手回复）。");
  }

  const usage = [];
  let calls = 0;

  const runOnce = async (user, retryNote, prompt = system) => {
    calls += 1;
    const result = await callForMap(callModel, { system: prompt, user, options: normalizeOptions, retryNote, log });
    if (result.usage) usage.push(result.usage);
    return result;
  };

  if (plan.groups.length === 1) {
    const transcript = renderTranscript(plan.groups[0], plan.budget);
    const user = buildUserPrompt({ sessionTitle, transcript, focus });
    let result = await runOnce(user, null);
    if (!result.map) {
      log?.(`首次输出不可用（${result.failure}），按失败原因重试一次`);
      result = await runOnce(user, RETRY_NOTES[result.failure]);
    }
    if (!result.map) throw unusableAnswer(result);
    return { map: result.map, calls, usage, squeezed: plan.squeezed, segments: 1 };
  }

  // Map: one partial map per segment.
  const partials = [];
  for (const [index, group] of plan.groups.entries()) {
    const transcript = renderTranscript(group, plan.budget);
    const user = buildUserPrompt({
      sessionTitle,
      transcript,
      part: index + 1,
      total: plan.groups.length,
      focus,
    });
    let result = await runOnce(user, null);
    if (!result.map) {
      log?.(`第 ${index + 1} 段输出不可用（${result.failure}），按失败原因重试一次`);
      result = await runOnce(user, RETRY_NOTES[result.failure]);
    }
    if (result.map) partials.push(result.map);
    else log?.(`第 ${index + 1} 段放弃：${result.failure}`);
  }

  if (partials.length === 0) {
    throw new Error("会话被切成多段后，每一段都没有产出可用的脑图。可尝试换模型或调大 maxInputTokens。");
  }

  // Reduce: merge the partial maps.
  const partialsText = serializePartials(partials);
  const mergeUser = buildMergePrompt({ sessionTitle, partials: partialsText, language, focus });
  let merged = await runOnce(mergeUser, null, mergeSystem);
  if (!merged.map) {
    log?.(`合并输出不可用（${merged.failure}），按失败原因重试一次`);
    merged = await runOnce(mergeUser, RETRY_NOTES[merged.failure], mergeSystem);
  }
  if (!merged.map) {
    // Last resort: keep the first partial map rather than failing the run.
    log?.("合并失败，退化为第 1 段的局部脑图");
    return { map: partials[0], calls, usage, squeezed: plan.squeezed, segments: plan.groups.length };
  }
  return { map: merged.map, calls, usage, squeezed: plan.squeezed, segments: plan.groups.length };
}
