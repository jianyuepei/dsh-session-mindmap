/**
 * Host-side seams that do not depend on DSH packages.
 *
 * Everything a reviewer wants to assert about this plugin — the tool contract,
 * the command contract, session/model resolution, argument parsing — lives here
 * so the test suite runs on a clean checkout with no DSH install. `lib/index.js`
 * only wires these pieces to `ctx`.
 *
 * @module dsh-session-mindmap/plugin
 */

import { isAbsolute, resolve } from "node:path";

import { OPEN_MODES } from "./deliver.js";
import { NODE_KINDS, DEFAULT_KINDS } from "./schema.js";

/** Log prefix and message namespace. */
export const LOG = "session-mindmap";

/** Bundled plugin version, reported inside generated files. */
export const VERSION = "0.2.0";

/**
 * Runtime defaults.
 *
 * The Cordis loader fills these from the exported `Config` schema; the pipeline
 * merges them anyway so it behaves identically when driven directly (tests, or
 * a future CLI) with a partial config object.
 */
export const DEFAULT_CONFIG = Object.freeze({
  provider: "",
  model: "",
  kinds: [...DEFAULT_KINDS],
  language: "zh",
  maxInputTokens: 24000,
  maxBlocks: 8,
  maxNodes: 80,
  maxDepth: 4,
  maxOutputTokens: 8000,
  temperature: 0.2,
  llmTimeoutMs: 180000,
  outputDir: ".dsh/mindmap",
  cache: true,
  openAfterBuild: true,
});

/** Merge a partial config over the runtime defaults. */
export function resolveConfig(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  merged.kinds = resolveKinds(merged.kinds, "");
  merged.language = merged.language === "en" ? "en" : "zh";
  return merged;
}

/** Normalise a possibly-branded id to a plain non-empty string. */
export function asId(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

/**
 * Resolve which session to summarise.
 *
 * @param {object} sessionQuery
 * @param {string} [requested] - explicit id, `last`, or empty.
 * @param {{id?: string}} [agent] - the calling agent, when there is one.
 * @returns {Promise<string>}
 */
export async function resolveSessionId(sessionQuery, requested, agent) {
  const explicit = asId(requested);
  if (explicit && explicit !== "last") return explicit;
  if (explicit === "last" || !asId(agent?.id)) {
    const sessions = await sessionQuery.listSessions();
    const newest = asId(sessions?.[0]?.header?.id);
    if (!newest) throw new Error(`${LOG}: 找不到任何会话（会话列表为空）。`);
    return explicit === "last" ? newest : asId(agent?.id) || newest;
  }
  return asId(agent.id);
}

/**
 * Model route for one run: explicit config wins, otherwise the host default.
 *
 * @param {object} ctx
 * @param {object} config
 * @returns {{provider: string, model: string, source: "config"|"default"}}
 */
export function resolveModel(ctx, config) {
  const provider = asId(config.provider);
  const model = asId(config.model);
  if (provider && model) return { provider, model, source: "config" };
  const selection = ctx.get?.("agentDefaultModel")?.currentSelection?.();
  const fallbackProvider = asId(selection?.provider);
  const fallbackModel = asId(selection?.model);
  if (!fallbackProvider || !fallbackModel) {
    throw new Error(
      `${LOG}: 无法确定模型。请在插件配置里显式设置 provider/model，或先在 DSH 里选好默认模型。`,
    );
  }
  return { provider: provider || fallbackProvider, model: model || fallbackModel, source: "default" };
}

/** Enabled kinds: config default, optionally overridden by a CSV string. */
export function resolveKinds(configKinds, override) {
  const base = Array.isArray(configKinds) && configKinds.length > 0 ? configKinds : [...DEFAULT_KINDS];
  const raw = typeof override === "string" && override.trim() !== "" ? override.split(",") : base;
  const kinds = [];
  for (const entry of raw) {
    const kind = String(entry).trim().toLowerCase();
    if (NODE_KINDS.includes(kind) && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds.length > 0 ? kinds : [...DEFAULT_KINDS];
}

/** Combine the caller's cancellation with a per-call timeout. */
export function withTimeout(signal, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return signal;
  const timeout = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : null;
  if (!timeout) return signal;
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

/** `yyyymmdd-HHMM`, in local time. */
export function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/** `2026-10-04 23:43`, local time. */
export function formatTimestamp(epochMs) {
  const value = Number(epochMs);
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  const pad = (input) => String(input).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * List recent sessions so their ids can be used with `sessionId`.
 *
 * Ids are what the tool needs, but the GUI shows titles — so the only way to
 * mind-map an older session is to be told both.
 *
 * @param {object} sessionQuery
 * @param {object} [options]
 * @param {number} [options.limit=10]
 * @param {"zh"|"en"} [options.language]
 * @returns {Promise<string>} the listing, as plain text.
 */
export async function listRecentSessions(sessionQuery, { limit = 10, language = "zh" } = {}) {
  if (!sessionQuery || typeof sessionQuery.listSessions !== "function") {
    throw new Error(`${LOG}: sessionQuery 服务不可用，无法列出会话。`);
  }
  const zh = language !== "en";
  const sessions = (await sessionQuery.listSessions()).slice(0, Math.max(1, limit));
  if (sessions.length === 0) return zh ? "没有任何会话。" : "No sessions.";

  const titles = new Map();
  const ids = sessions.map((session) => session?.header?.id).filter(Boolean);
  if (typeof sessionQuery.readTitleSnapshots === "function" && ids.length > 0) {
    const rows = await Promise.resolve(sessionQuery.readTitleSnapshots(ids)).catch(() => []);
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.status !== "fulfilled") continue;
      const title = row.value?.title?.title;
      if (typeof title === "string" && title !== "") titles.set(row.sessionId, title);
    }
  }

  const lines = [
    zh
      ? `最近 ${sessions.length} 个会话（用 /mindmap <id> 生成脑图）：`
      : `Latest ${sessions.length} sessions (use /mindmap <id>):`,
  ];
  sessions.forEach((session, index) => {
    const id = session?.header?.id ?? "?";
    const when = formatTimestamp(session?.header?.createdAt);
    const title = titles.get(id) ?? (zh ? "（无标题）" : "(untitled)");
    const live = session?.live ? (zh ? " · 进行中" : " · live") : "";
    lines.push(`${String(index + 1).padStart(2)}. ${id}  ${when}${live}  ${title}`);
  });
  return lines.join("\n");
}

/** Parse `/mindmap` arguments. */
export function parseCommandInput(rawInput) {
  const result = { sessionId: "", focus: "", kinds: "", language: "", force: false, openMode: "", list: false };
  for (const part of String(rawInput ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)) {
    if (part === "--force" || part === "-f") result.force = true;
    else if (part === "--open" || part === "-o") result.openMode = "open";
    else if (part === "--reveal") result.openMode = "reveal";
    else if (part === "--no-open") result.openMode = "none";
    else if (part.startsWith("--focus=")) result.focus = part.slice("--focus=".length);
    else if (part.startsWith("--kinds=")) result.kinds = part.slice("--kinds=".length);
    else if (part.startsWith("--lang=")) result.language = part.slice("--lang=".length);
    else if (!part.startsWith("-") && part === "list") result.list = true;
    else if (!part.startsWith("-") && !result.sessionId) result.sessionId = part;
  }
  return result;
}

/**
 * Absolute directory an artifact for `cwd` belongs in.
 * @param {object} [config]
 * @param {string} [cwd]
 * @returns {string}
 */
export function artifactDir(config, cwd) {
  const dir = config?.outputDir || DEFAULT_CONFIG.outputDir;
  return isAbsolute(dir) ? dir : resolve(cwd || process.cwd(), dir);
}

/**
 * Human summary shared by the tool result and the command result.
 *
 * When the artifact is being served (the normal case inside the desktop app) the
 * summary carries a same-origin Markdown link, so the mind map is one click
 * away instead of a path to copy. The path stays as a plain line for terminals,
 * logs and headless runs.
 */
export function summarize(result, language, { link = true } = {}) {
  const effective = result.language === "en" || result.language === "zh" ? result.language : language;
  const zh = effective !== "en";
  const head = zh
    ? `脑图已生成：${result.title}（${result.nodeCount} 个节点｜${result.turns} 轮｜${result.model}${result.cached ? "｜缓存命中" : ""}）`
    : `Mind map ready: ${result.title} (${result.nodeCount} nodes | ${result.turns} turns | ${result.model}${result.cached ? " | cached" : ""})`;
  // The command row renders plain text, so it reports what the plugin already
  // did rather than handing over a link that would show up as literal Markdown.
  const opened =
    result.opened === "open"
      ? zh
        ? "已用默认浏览器打开"
        : "Opened in the default browser"
      : result.opened === "reveal"
        ? zh
          ? "已在文件管理器中选中该文件"
          : "Revealed in the file manager"
        : "";
  const linkLine =
    link && result.viewPath
      ? zh
        ? `▶ [点击打开脑图](${result.viewPath})`
        : `▶ [Open the mind map](${result.viewPath})`
      : "";
  const deltaLine = result.delta ? `↺ ${result.delta}` : "";
  const file = zh ? `文件：${result.htmlPath}` : `File: ${result.htmlPath}`;
  return [head, opened, deltaLine, linkLine, file].filter(Boolean).join("\n");
}

/**
 * The open behaviour of one `/mindmap` run.
 *
 * A flag wins over the config, and the config default is "open" because the
 * command is typed by a human who wants to see the map. Only `none` is ever
 * chosen for a model-invoked call — see `toolRequest`.
 *
 * @param {object} [parsed] - `parseCommandInput` result.
 * @param {object} [config]
 * @returns {"none"|"open"|"reveal"}
 */
export function commandOpenMode(parsed = {}, config = {}) {
  const explicit = String(parsed?.openMode ?? "");
  if (OPEN_MODES.includes(explicit)) return explicit;
  return config?.openAfterBuild === false ? "none" : "open";
}

/**
 * The pipeline request for a model-invoked call.
 *
 * `openMode` is hard-coded here, and deliberately not read from `args`: the two
 * entry points differ exactly in whether a window may pop, and a shared wrapper
 * with a hidden default once erased that difference (the command stopped opening
 * the artifact). Keeping the two builders separate is what makes the difference
 * visible and testable.
 *
 * @param {object} args - validated tool arguments.
 * @param {object} exec
 * @param {object} [shared] - `{registry}`
 * @returns {object}
 */
export function toolRequest(args = {}, exec = {}, shared = {}) {
  return {
    sessionId: args.sessionId,
    kinds: args.kinds,
    focus: args.focus,
    language: args.language,
    force: args.force === true,
    openMode: "none",
    signal: exec?.signal,
    agent: exec?.agent,
    registry: shared.registry,
  };
}

/**
 * The pipeline request for a human-typed command.
 *
 * @param {object} parsed - `parseCommandInput` result.
 * @param {object} invocation
 * @param {object} [config]
 * @param {object} [shared] - `{registry}`
 * @returns {object}
 */
export function commandRequest(parsed = {}, invocation = {}, config = {}, shared = {}) {
  return {
    sessionId: parsed.sessionId,
    kinds: parsed.kinds,
    focus: parsed.focus,
    language: parsed.language,
    force: parsed.force === true,
    openMode: commandOpenMode(parsed, config),
    signal: invocation?.signal,
    agent: invocation?.agent,
    registry: shared.registry,
  };
}

/**
 * The `session_mindmap` tool contract, as a plain options object.
 *
 * Returned un-registered so tests can assert the shape without importing
 * `@deepseek-ai/dsh-tools`; `lib/index.js` hands it to `defineTool`.
 *
 * @param {object} options
 * @param {object} options.config - resolved plugin config.
 * @param {number} options.timeoutMs
 * @param {(args: object, exec: object) => Promise<object>} options.run
 * @returns {object}
 */
export function buildToolOptions({ config, timeoutMs, run }) {
  return {
    name: "session_mindmap",
    description:
      "把会话的核心内容整理成一张自包含的 HTML 脑图（主题/结论/决策与理由/待办/未决问题），" +
      "写进会话工作区的 .dsh/mindmap/ 目录。默认整理当前会话；可传 sessionId 或 'last' 整理历史会话。" +
      "适合在一个阶段结束时留档，或把过程讲给别人听。",
    parameters: {
      sessionId: {
        type: "string",
        description: "目标会话 id；省略表示当前会话，'last' 表示最近一个会话。",
      },
      kinds: {
        type: "string",
        description:
          "逗号分隔的抽取维度，可选 topic/conclusion/decision/todo/question/file；省略用插件默认值（默认不含 file）。",
      },
      focus: { type: "string", description: "可选：只围绕某个主题整理这张脑图。" },
      language: { type: "string", description: "节点语言：zh 或 en；省略用插件配置（默认 zh）。" },
      force: { type: "boolean", description: "忽略缓存，重新调用模型生成。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: "string" },
          title: { type: "string" },
          nodeCount: { type: "integer" },
          model: { type: "string" },
          turns: { type: "integer" },
          calls: { type: "integer" },
          cached: { type: "boolean" },
          htmlPath: { type: "string" },
          viewPath: { type: "string" },
          opened: { type: "string" },
          delta: { type: "string" },
          addedCount: { type: "integer" },
          removedCount: { type: "integer" },
          language: { type: "string" },
          outline: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `${summarize(value, config.language)}\n\n${value.outline ?? ""}` },
      ],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return run(args ?? {}, exec ?? {});
    },
  };
}

/**
 * The `/mindmap` command contract, as a plain definition object.
 *
 * @param {object} options
 * @param {object} options.config
 * @param {(parsed: object, invocation: object) => Promise<object>} options.run
 * @returns {object}
 */
export function buildCommandDefinition({ config, run, list }) {
  return {
    name: "mindmap",
    description: "把会话的核心内容生成一张 HTML 脑图（默认当前会话）；list 子命令列出最近会话",
    input: {
      hint: "list | [sessionId|last] [--focus=主题] [--kinds=topic,decision] [--lang=en] [--force] [--open|--reveal|--no-open]",
    },
    async handler(invocation) {
      const parsed = parseCommandInput(invocation?.rawInput);
      try {
        if (parsed.list) {
          if (typeof list !== "function") {
            return { kind: "error", text: `${LOG}: 当前宿主不支持列出会话。` };
          }
          return { kind: "success", text: await list(parsed) };
        }
        const result = await run(parsed, invocation);
        return { kind: "success", text: summarize(result, config.language, { link: false }) };
      } catch (error) {
        return { kind: "error", text: `${LOG}: ${error?.message ?? error}` };
      }
    },
  };
}
