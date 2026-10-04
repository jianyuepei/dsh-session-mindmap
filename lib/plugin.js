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

import { NODE_KINDS, DEFAULT_KINDS } from "./schema.js";

/** Log prefix and message namespace. */
export const LOG = "session-mindmap";

/** Bundled plugin version, reported inside generated files. */
export const VERSION = "0.1.0";

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
  maxOutputTokens: 4000,
  temperature: 0.2,
  llmTimeoutMs: 180000,
  outputDir: ".dsh/mindmap",
  cache: true,
  openAfterBuild: false,
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

/** Parse `/mindmap` arguments. */
export function parseCommandInput(rawInput) {
  const result = { sessionId: "", focus: "", kinds: "", language: "", force: false, open: false };
  for (const part of String(rawInput ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)) {
    if (part === "--force" || part === "-f") result.force = true;
    else if (part === "--open" || part === "-o") result.open = true;
    else if (part.startsWith("--focus=")) result.focus = part.slice("--focus=".length);
    else if (part.startsWith("--kinds=")) result.kinds = part.slice("--kinds=".length);
    else if (part.startsWith("--lang=")) result.language = part.slice("--lang=".length);
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
export function summarize(result, language) {
  const effective = result.language === "en" || result.language === "zh" ? result.language : language;
  const zh = effective !== "en";
  const head = zh
    ? `脑图已生成：${result.title}（${result.nodeCount} 个节点｜${result.turns} 轮｜${result.model}${result.cached ? "｜缓存命中" : ""}）`
    : `Mind map ready: ${result.title} (${result.nodeCount} nodes | ${result.turns} turns | ${result.model}${result.cached ? " | cached" : ""})`;
  const link = result.viewPath
    ? zh
      ? `▶ [点击打开脑图](${result.viewPath})`
      : `▶ [Open the mind map](${result.viewPath})`
    : "";
  const file = zh ? `文件：${result.htmlPath}` : `File: ${result.htmlPath}`;
  return [head, link, file].filter(Boolean).join("\n");
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
export function buildCommandDefinition({ config, run }) {
  return {
    name: "mindmap",
    description: "把会话的核心内容生成一张 HTML 脑图（默认当前会话）",
    input: { hint: "[sessionId|last] [--focus=主题] [--kinds=topic,decision] [--lang=en] [--force] [--open]" },
    async handler(invocation) {
      const parsed = parseCommandInput(invocation?.rawInput);
      try {
        const result = await run(parsed, invocation);
        return { kind: "success", text: summarize(result, config.language) };
      } catch (error) {
        return { kind: "error", text: `${LOG}: ${error?.message ?? error}` };
      }
    },
  };
}
