/**
 * Read → extract → organise → render → write.
 *
 * Deliberately free of DSH imports: the pipeline takes a `ctx`-shaped object
 * and is therefore fully drivable from a test with a fake session query and a
 * fake LLM. `lib/index.js` owns everything that needs a real Cordis context.
 *
 * @module dsh-session-mindmap/pipeline
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { collectTurns } from "./extract.js";
import { collectStream, generateMindMap } from "./organize.js";
import {
  LOG,
  VERSION,
  artifactDir,
  resolveConfig,
  resolveKinds,
  resolveModel,
  resolveSessionId,
  stamp,
  withTimeout,
} from "./plugin.js";
import { renderHtml } from "./render-html.js";
import { toMarkdown, toMermaid, toOutline } from "./render-md.js";
import { PROMPT_VERSION, countNodes } from "./schema.js";
import { artifactUrl } from "./serve.js";
import { openTarget } from "./deliver.js";
import { collectLabels, describeDelta, diffMaps } from "./diff.js";
import { previousFor, readHistory, withEntry, writeHistory } from "./history.js";

/** Open a path with the platform opener; never awaited, never fatal. */
export function openPath(target, logger) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", (error) => logger?.warn?.(`打开文件失败：${error.message}`));
    child.unref();
  } catch (error) {
    logger?.warn?.(`打开文件失败：${error?.message ?? error}`);
  }
}

/**
 * Generate one mind map for one session.
 *
 * @param {object} ctx - Cordis context (only `get` and an optional `logger` are used).
 * @param {object} config - plugin config; missing keys fall back to the defaults.
 * @param {object} request
 * @param {string} [request.sessionId] - explicit id, `last`, or empty for the calling agent.
 * @param {string} [request.kinds] - CSV override of `config.kinds`.
 * @param {string} [request.focus] - bias the summary towards one topic.
 * @param {boolean} [request.force] - ignore the cache.
 * @param {"none"|"open"|"reveal"} [request.openMode] - what to do with the artifact afterwards.
 * @param {AbortSignal} [request.signal]
 * @param {{id?: string}} [request.agent]
 * @param {{remember(path: string): string}} [request.registry] - artifact whitelist,
 *   so the generated file can be served back with a clickable link.
 * @returns {Promise<object>} the tool/command payload.
 */
export async function runMindMap(ctx, config, request = {}) {
  const cfg = resolveConfig(config);
  const logger = ctx.logger?.(LOG);
  const sessionQuery = ctx.get?.("sessionQuery");
  if (!sessionQuery || typeof sessionQuery.readSurface !== "function") {
    throw new Error(`${LOG}: sessionQuery 服务不可用，无法读取会话。`);
  }
  const llm = ctx.get?.("llm");
  if (!llm || typeof llm.stream !== "function") {
    throw new Error(`${LOG}: llm 服务不可用，无法生成脑图。`);
  }

  const sessionId = await resolveSessionId(sessionQuery, request.sessionId, request.agent);
  const surface = await sessionQuery.readSurface(sessionId);
  const events = surface?.events ?? [];
  const header = surface?.session ?? {};
  const titlePromise = sessionQuery.readTitle?.(sessionId);
  const titleSnapshot = titlePromise ? await Promise.resolve(titlePromise).catch(() => undefined) : undefined;
  const sessionTitle = titleSnapshot?.title ?? "";
  const kinds = resolveKinds(cfg.kinds, request.kinds);
  // Per-call override so one English map can be made without touching config.
  const language = request.language === "en" || request.language === "zh" ? request.language : cfg.language;
  const { provider, model: modelId } = resolveModel(ctx, cfg);
  const modelLabel = `${provider}/${modelId}`;

  const { turns } = collectTurns(events);
  if (turns.length === 0) {
    throw new Error(`${LOG}: 该会话没有可整理的内容（没有用户消息、助手回复或工具调用）。`);
  }

  const workspace = header.cwd || process.cwd();
  const directory = artifactDir(cfg, workspace);
  await mkdir(directory, { recursive: true });

  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify({
        sessionId,
        capturedThroughSeq: surface?.capturedThroughSeq ?? null,
        kinds,
        focus: request.focus ?? "",
        model: modelLabel,
        language,
        maxNodes: cfg.maxNodes,
        maxDepth: cfg.maxDepth,
        promptVersion: PROMPT_VERSION,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  const cachePath = join(directory, ".cache", `${cacheKey}.json`);

  // The previous generation is needed twice: its labels steer the prompt (so an
  // unchanged topic keeps its wording and the diff stays meaningful), and its
  // map is the baseline for the delta.
  const capturedThroughSeq = surface?.capturedThroughSeq ?? null;
  const history = await readHistory(directory);
  const previousEntry = previousFor(history.entries, sessionId, capturedThroughSeq);
  const previousMap = previousEntry
    ? await readFile(join(directory, ".cache", `${previousEntry.cacheKey}.json`), "utf8")
        .then((text) => JSON.parse(text)?.map ?? null)
        .catch(() => null)
    : null;

  let map;
  let markdown;
  let mermaid;
  let cached = false;
  let calls = 0;

  if (cfg.cache && !request.force) {
    const hit = await readFile(cachePath, "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    if (hit?.map?.root) {
      ({ map, markdown, mermaid } = hit);
      cached = true;
      calls = hit.calls ?? 0;
    }
  }

  if (!map) {
    const signal = withTimeout(request.signal, cfg.llmTimeoutMs);
    const result = await generateMindMap({
      callModel: async ({ system, user }) => {
        const response = await collectStream((options) => llm.stream(options), {
          provider,
          model: modelId,
          system,
          messages: [{ role: "user", content: [{ type: "text", text: user }] }],
          maxTokens: cfg.maxOutputTokens,
          temperature: cfg.temperature,
          signal,
        });
        return { text: response.text, usage: response.usage, finish: response.finish };
      },
      sessionTitle,
      turns,
      config: { ...cfg, kinds, language },
      focus: request.focus,
      previousLabels: collectLabels(previousMap),
      log: (message) => logger?.info?.(message),
    });
    map = result.map;
    calls = result.calls;
    markdown = toMarkdown(map, {
      sessionId,
      model: modelLabel,
      generatedAt: Date.now(),
      turnCount: turns.length,
      language,
    });
    mermaid = toMermaid(map);
    await mkdir(join(directory, ".cache"), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify(
        {
          map,
          markdown,
          mermaid,
          calls,
          model: modelLabel,
          // Metadata for the history index: without it a later run cannot tell
          // which cached map belongs to this session.
          sessionId,
          capturedThroughSeq: surface?.capturedThroughSeq ?? null,
          generatedAt: Date.now(),
          language,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  // What changed since the previous run for this session. Deterministic and
  // free: it diffs two node trees, it does not ask the model anything.
  let delta;
  let previousMeta;
  if (previousMap?.root) {
    delta = diffMaps(previousMap, map);
    previousMeta = {
      title: previousMap.title ?? previousEntry?.title ?? "",
      generatedAt: Number(previousEntry?.generatedAt) || undefined,
      nodeCount: Number(previousEntry?.nodeCount) || undefined,
    };
  }

  const fileBase = `${sessionId}-${stamp()}`;
  const htmlPath = join(directory, `${fileBase}.html`);
  await writeFile(
    htmlPath,
    renderHtml({
      map,
      markdown,
      mermaid,
      meta: {
        sessionId,
        sessionTitle,
        model: modelLabel,
        generatedAt: Date.now(),
        turnCount: turns.length,
        language,
        version: VERSION,
        fileBase,
        calls,
        delta: delta ? { ...delta, previous: previousMeta } : null,
        // Lets the artifact say which part of the conversation a node came from.
        segments: turns.map((turn) => ({
          index: turn.index,
          turn: turn.turn,
          firstSeq: turn.firstSeq,
          lastSeq: turn.lastSeq,
        })),
      },
    }),
    "utf8",
  );

  // Registering the artifact is what turns the result into a clickable link:
  // the route only ever serves ids the plugin itself put in this whitelist.
  const artifactId = request.registry?.remember?.(htmlPath);

  const result = {
    sessionId,
    title: map.title,
    nodeCount: countNodes(map.root),
    model: modelLabel,
    turns: turns.length,
    calls,
    cached,
    htmlPath,
    viewPath: artifactId ? artifactUrl(artifactId) : "",
    language,
    delta: delta && delta.hasChanges ? describeDelta(delta, language) : "",
    addedCount: delta?.added.length ?? 0,
    removedCount: delta?.removed.length ?? 0,
    outline: toOutline(map),
  };

  // Remember this generation so the next run can diff against it.
  await writeHistory(
    directory,
    withEntry(history.entries, {
      sessionId,
      cacheKey,
      capturedThroughSeq,
      generatedAt: Date.now(),
      title: map.title,
      nodeCount: result.nodeCount,
      language,
      model: modelLabel,
    }),
  ).catch((error) => logger?.warn?.(`历史索引写入失败：${error?.message ?? error}`));

  logger?.info?.(
    `已生成脑图：${htmlPath}（${result.nodeCount} 节点，${turns.length} 轮，${cached ? "缓存命中" : `${calls} 次模型调用`}）`,
  );

  const openMode = request.openMode ?? "none";
  if (openMode !== "none" && openTarget(htmlPath, openMode, logger)) result.opened = openMode;

  return result;
}
