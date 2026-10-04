/**
 * Session event stream → per-turn blocks.
 *
 * Pure module: no `ctx`, no I/O, no clock. Everything here is unit-testable
 * against synthetic event arrays, which keeps real session content out of the
 * test suite (see README, Privacy).
 *
 * @module dsh-session-mindmap/extract
 */

/** Keys whose string value is always a file being operated on. */
const STRICT_PATH_KEYS = new Set(["file_path", "filepath", "target_file", "notebook_path", "file"]);
/**
 * `path` is ambiguous: `read`/`write` use it for a file, while search tools use
 * it for a directory root. It is only accepted when the last segment looks like
 * a file name, so `grep {"path":"/tmp"}` does not become an "involved file".
 */
const LOOSE_PATH_KEYS = new Set(["path"]);

/** Collapse whitespace runs and clip to `max` characters. */
export function clip(text, max) {
  const flat = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (max === undefined || max === null || flat.length <= max) return flat;
  if (max <= 1) return flat.slice(0, Math.max(0, max));
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Plain text of one content-block list.
 *
 * DSH messages carry `readonly ContentBlock[]`; only `text` blocks contribute
 * to a summary. Reasoning, images, files and tool-call blocks are dropped.
 *
 * @param {unknown} content - the message's `content` field.
 * @returns {string} joined text, trimmed.
 */
export function blocksToText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/** True when a candidate looks like a usable path rather than prose. */
function looksLikePath(value) {
  return value.length > 0 && value.length <= 400 && !value.includes("\n");
}

/** True when the last path segment looks like a file name rather than a folder. */
function looksLikeFileName(value) {
  const last = value.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return last.includes(".");
}

/**
 * File paths mentioned by one tool call's raw argument JSON.
 *
 * Best effort by design: it walks the parsed object two levels deep and
 * collects strings under known path keys, plus `files[].path`. Unknown shapes
 * yield an empty list rather than a guess.
 *
 * @param {unknown} rawArguments - `tool/call.data.arguments` (a JSON string).
 * @returns {string[]} unique paths, in discovery order.
 */
export function filePathsFromToolArgs(rawArguments) {
  if (typeof rawArguments !== "string" || rawArguments.trim() === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return [];
  }
  const found = [];
  const seen = new Set();
  const visit = (node, depth, inFileList) => {
    if (!node || typeof node !== "object" || depth > 2) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, inFileList);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const lower = key.toLowerCase();
      // Container keys scope their children as file references; they do not
      // make the current key itself one (`{"path":"/tmp"}` is still a search root).
      const childFileList = inFileList || /^(files?|attachments?|paths?)$/.test(lower);
      if (typeof value === "string") {
        const isStrict = STRICT_PATH_KEYS.has(lower) && looksLikePath(value);
        const isLoose =
          LOOSE_PATH_KEYS.has(lower) && looksLikePath(value) && (inFileList || looksLikeFileName(value));
        if (isStrict || isLoose) {
          if (!seen.has(value)) {
            seen.add(value);
            found.push(value);
          }
          continue;
        }
      }
      if (value && typeof value === "object") visit(value, depth + 1, childFileList);
    }
  };
  visit(parsed, 0, false);
  return found;
}

/** Ascending order by `seq`, tolerating missing/duplicate values. */
function bySeq(a, b) {
  return (a?.seq ?? 0) - (b?.seq ?? 0);
}

/** Text a `user/message` or `assistant/message` data payload contributes. */
function eventText(event) {
  const data = event.data ?? {};
  switch (event.type) {
    case "user/message":
      return blocksToText(data.content);
    case "assistant/message":
      return blocksToText(data.message?.content);
    default:
      return "";
  }
}

/**
 * Tool calls carried inside one assistant message.
 *
 * On the model surface there are no `tool/call` events: a call reaches the
 * model as a `tool-call` content block inside the assistant message. Reading
 * them here is what makes tool names and touched files available when the
 * input comes from `sessionQuery.readSurface`.
 *
 * @param {unknown} message - `assistant/message.data.message`
 * @returns {{names: string[], files: string[]}}
 */
export function toolCallsInMessage(message) {
  const names = [];
  const files = [];
  const content = message?.content;
  if (!Array.isArray(content)) return { names, files };
  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "tool-call") continue;
    const name = String(block.name ?? "").trim();
    if (name && !names.includes(name)) names.push(name);
    for (const path of filePathsFromToolArgs(block.arguments)) {
      if (!files.includes(path)) files.push(path);
    }
  }
  return { names, files };
}

/**
 * @typedef {object} TurnBlock
 * @property {number} turn - 1-based turn index as reported by `turn/start`.
 * @property {number} firstSeq - lowest event seq folded into this block.
 * @property {number} lastSeq - highest event seq folded into this block.
 * @property {string} user - clipped user intent for the turn.
 * @property {string} assistant - clipped assistant output for the turn.
 * @property {string[]} tools - tool names called in the turn, unique, in order.
 * @property {string[]} files - file paths touched, unique, in order.
 * @property {string[]} errors - failed tool calls, as `name: code`.
 */

/**
 * Fold a session event log into per-turn blocks.
 *
 * Events outside a turn (session headers, request headers, projections,
 * developer/system messages, streaming fragments) are ignored: a summary needs
 * what the user asked and what was produced, not the plumbing.
 *
 * @param {readonly object[]} events - `SessionEvent[]` in seq order.
 * @param {object} [options]
 * @param {number} [options.userChars=800] - per-turn user text budget.
 * @param {number} [options.assistantChars=1200] - per-turn assistant text budget.
 * @returns {{turns: TurnBlock[], eventCount: number, ignored: number}}
 */
export function collectTurns(events, options = {}) {
  const userChars = options.userChars ?? 800;
  const assistantChars = options.assistantChars ?? 1200;
  const list = Array.isArray(events) ? [...events].sort(bySeq) : [];

  /** @type {Array<{turn:number,firstSeq:number,lastSeq:number,user:string[],assistant:string[],tools:string[],files:string[],errors:string[]}>} */
  const turns = [];
  let current = null;
  let ignored = 0;

  const open = (turn) => {
    current = {
      turn: Number.isFinite(turn) ? turn : turns.length + 1,
      firstSeq: 0,
      lastSeq: 0,
      user: [],
      assistant: [],
      tools: [],
      files: [],
      errors: [],
    };
    turns.push(current);
    return current;
  };
  const touch = (event) => {
    if (!current) return;
    const seq = Number(event?.seq ?? 0);
    if (current.firstSeq === 0) current.firstSeq = seq;
    current.lastSeq = seq;
  };

  for (const event of list) {
    if (!event || typeof event !== "object") {
      ignored += 1;
      continue;
    }
    const data = event.data ?? {};
    switch (event.type) {
      case "turn/start": {
        open(data.turn);
        touch(event);
        break;
      }
      case "turn/end": {
        touch(event);
        break;
      }
      case "user/message": {
        const text = eventText(event);
        if (!current) open(turns.length + 1);
        touch(event);
        if (text) current.user.push(text);
        break;
      }
      case "assistant/message": {
        const text = eventText(event);
        if (!current) open(turns.length + 1);
        touch(event);
        if (text) current.assistant.push(text);
        const calls = toolCallsInMessage(data.message);
        for (const name of calls.names) {
          if (!current.tools.includes(name)) current.tools.push(name);
        }
        for (const path of calls.files) {
          if (!current.files.includes(path)) current.files.push(path);
        }
        break;
      }
      case "tool/call": {
        if (!current) open(turns.length + 1);
        touch(event);
        const name = String(data.name ?? "").trim();
        if (name && !current.tools.includes(name)) current.tools.push(name);
        for (const path of filePathsFromToolArgs(data.arguments)) {
          if (!current.files.includes(path)) current.files.push(path);
        }
        break;
      }
      case "tool/result": {
        if (!current) break;
        touch(event);
        if (data.error) {
          const label = [data.error.name, data.error.code].filter(Boolean).join(": ");
          if (label && !current.errors.includes(label)) current.errors.push(label);
        }
        break;
      }
      default:
        ignored += 1;
    }
  }

  const blocks = [];
  for (const turn of turns) {
    const user = clip(turn.user.join("\n"), userChars);
    const assistant = clip(turn.assistant.join("\n"), assistantChars);
    if (!user && !assistant && turn.tools.length === 0) continue;
    blocks.push({
      turn: turn.turn,
      firstSeq: turn.firstSeq,
      lastSeq: turn.lastSeq,
      user,
      assistant,
      tools: turn.tools,
      files: turn.files,
      errors: turn.errors,
    });
  }

  return { turns: blocks, eventCount: list.length, ignored };
}
