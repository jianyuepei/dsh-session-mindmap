/**
 * Mind-map data model: parsing, normalisation and clamping.
 *
 * The LLM is asked for strict JSON, but a model response is never trusted:
 * every field is coerced, unknown node kinds fall back to `topic`, siblings
 * are de-duplicated, and the tree is clamped to the configured node/depth
 * budget. Pure module — no `ctx`, no I/O.
 *
 * @module dsh-session-mindmap/schema
 */

/** Node kinds a mind map may contain. */
export const NODE_KINDS = Object.freeze([
  "topic",
  "conclusion",
  "decision",
  "todo",
  "question",
  "file",
]);

/** Human labels per kind, per output language. */
export const KIND_LABELS = Object.freeze({
  zh: {
    topic: "主题",
    conclusion: "结论",
    decision: "决策",
    todo: "待办",
    question: "未决问题",
    file: "涉及文件",
  },
  en: {
    topic: "Topic",
    conclusion: "Conclusion",
    decision: "Decision",
    todo: "Todo",
    question: "Open question",
    file: "File",
  },
});

/** Kinds enabled unless the caller says otherwise (`file` is opt-in). */
export const DEFAULT_KINDS = Object.freeze([
  "topic",
  "conclusion",
  "decision",
  "todo",
  "question",
]);

/** Bump when the prompt or the normalisation rules change, to invalidate caches. */
export const PROMPT_VERSION = 1;

/** Collapse whitespace and clip, without the turn-level semantics of extract's clip. */
function clipText(value, max) {
  const flat = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Parse the first complete JSON object out of a model answer.
 *
 * Tolerates ```json fences and surrounding prose by scanning for the first
 * brace-balanced object. Returns `null` instead of throwing, so the caller can
 * decide to retry with the parse error attached.
 *
 * @param {unknown} text
 * @returns {object|null}
 */
export function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const cleaned = text
    .replace(/^\s*```(?:json)?[ \t]*\r?\n?/i, "")
    .replace(/\r?\n?[ \t]*```\s*$/, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(cleaned.slice(start, i + 1));
          return value && typeof value === "object" && !Array.isArray(value) ? value : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Session-event references attached to a node. */
function normalizeRefs(input) {
  const raw = input?.refs?.seq ?? input?.seq ?? input?.refs;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const seqs = [];
  for (const value of list) {
    const seq = Number(value);
    if (Number.isInteger(seq) && seq >= 0 && !seqs.includes(seq)) seqs.push(seq);
    if (seqs.length >= 20) break;
  }
  return seqs;
}

/**
 * Normalise one raw node (and its subtree) into the internal shape.
 *
 * @param {unknown} input
 * @param {number} depth - 0-based depth of this node.
 * @param {object} ctx - `{kinds, maxNodes, maxDepth, state}`.
 * @returns {object|null} the node, or null when it carries no usable label.
 */
function normalizeNode(input, depth, ctx) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (ctx.state.count >= ctx.maxNodes) {
    ctx.state.truncated = true;
    return null;
  }
  const label = clipText(input.label ?? input.title ?? input.text ?? input.name, 80);
  if (!label) return null;

  const rawKind = String(input.kind ?? input.type ?? "")
    .toLowerCase()
    .trim();
  const kind = ctx.kinds.has(rawKind) ? rawKind : "topic";
  const detail = clipText(input.detail ?? input.description ?? input.note, 400);

  ctx.state.count += 1;
  const node = {
    id: `n${ctx.state.count}`,
    label,
    kind,
    ...(detail ? { detail } : {}),
    refs: { seq: normalizeRefs(input) },
    children: [],
  };

  const rawChildren = Array.isArray(input.children) ? input.children : [];
  if (rawChildren.length > 0 && depth + 1 >= ctx.maxDepth) {
    ctx.state.truncated = true;
    return node;
  }
  const seen = new Set([label.toLowerCase()]);
  for (const child of rawChildren) {
    const normalized = normalizeNode(child, depth + 1, ctx);
    if (!normalized) continue;
    const key = normalized.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    node.children.push(normalized);
  }
  return node;
}

/**
 * Coerce a raw model object into a valid mind map.
 *
 * @param {unknown} raw - parsed model output.
 * @param {object} [options]
 * @param {string[]} [options.kinds] - allowed kinds (`file` is opt-in upstream).
 * @param {number} [options.maxNodes=80]
 * @param {number} [options.maxDepth=4]
 * @param {string} [options.title] - fallback title when the model omits one.
 * @returns {{title:string, root:object, nodeCount:number, truncated:boolean}|null}
 *   `null` when the answer contains no usable root node.
 */
export function normalizeMindMap(raw, options = {}) {
  if (!raw || typeof raw !== "object") return null;
  const kinds = new Set(
    (Array.isArray(options.kinds) && options.kinds.length > 0 ? options.kinds : DEFAULT_KINDS).filter(
      (kind) => NODE_KINDS.includes(kind),
    ),
  );
  const state = { count: 0, truncated: false };
  // A bare node is accepted as the root, but a map-level `title` alone is not a
  // mind map: the fallback only applies when an explicit node label exists.
  const bareRoot =
    raw.label !== undefined || raw.text !== undefined || raw.name !== undefined ? raw : null;
  const rootInput = raw.root ?? raw.mindmap ?? bareRoot;
  if (!rootInput) return null;
  const root = normalizeNode(rootInput, 0, {
    kinds,
    maxNodes: Math.max(2, options.maxNodes ?? 80),
    maxDepth: Math.max(1, options.maxDepth ?? 4),
    state,
  });
  if (!root) return null;
  const title = clipText(raw.title ?? raw.topic ?? options.title ?? "会话脑图", 120) || "会话脑图";
  return { title, root, nodeCount: state.count, truncated: state.truncated };
}

/** Depth-first node count, for tests and reporting. */
export function countNodes(node) {
  if (!node) return 0;
  let total = 1;
  for (const child of node.children ?? []) total += countNodes(child);
  return total;
}

/** Depth-first walk over nodes, parents before children. */
export function walk(node, visit, depth = 0) {
  if (!node) return;
  visit(node, depth);
  for (const child of node.children ?? []) walk(child, visit, depth + 1);
}
