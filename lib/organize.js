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
 * System prompt for one generation call.
 * @param {object} options
 * @param {string[]} options.kinds - enabled node kinds.
 * @param {"zh"|"en"} options.language
 * @returns {string}
 */
export function buildSystemPrompt({ kinds, language }) {
  const labels = KIND_LABELS[language === "en" ? "en" : "zh"];
  const kindLines = kinds.map((kind) => `- \`${kind}\`（${labels[kind]}）`).join("\n");
  const outputLanguage = language === "en" ? "英语" : "中文";
  return [
    "你是一个会话复盘助手。你会读到一段按轮次整理的会话记录，需要把它整理成一张脑图（思维导图）。",
    "",
    "硬性要求：",
    `1. 只输出一个 JSON 对象，不要有任何解释文字，不要用 Markdown 代码块包裹。`,
    `2. JSON 形状必须严格如下：\n${SHAPE_HINT}`,
    `3. 所有 label / detail / title 用${outputLanguage}书写；label 不超过 40 字，detail 不超过 120 字。`,
    "4. 只允许使用这些 kind：",
    kindLines,
    "5. 只写会话记录里真实出现过的内容，禁止脑补、禁止补充你自己的建议。",
    "6. 层级不要超过 4 层；节点总数不要超过 60；同一父节点下不要有重复 label。",
    "7. 尽量为每个节点填 refs.seq，写它依据的轮次 seq 区间里的任一 seq；没有依据就留空数组。",
    "8. 如果某一类信息在会话里不存在，就不要造节点。",
    kinds.includes("file")
      ? "9. 会话里读写过的文件放进 `file` 节点，挂在对应话题下面。"
      : "9. 本次不需要文件维度：不要为“涉及的文件”“改动过的文件”之类单独造节点。",
    "",
    "组织建议：root 是会话主题；一级节点是几个主要话题；把结论、决策（含理由）、待办、未决问题挂在对应话题下面。",
  ].join("\n");
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

/** One call: prompt in, parsed-and-normalised map out; `null` when unusable. */
async function callForMap(callModel, { system, user, options, retryNote }) {
  const messages = [user];
  if (retryNote) {
    messages.push(
      `你上一次的回答无法被解析为合法 JSON（${retryNote}）。请重新输出，只输出一个 JSON 对象本体，不要代码块、不要解释。`,
    );
  }
  const { text, usage } = await callModel({ system, user: messages.join("\n\n") });
  const parsed = extractJsonObject(text);
  if (!parsed) return { map: null, text, usage, error: "输出中找不到完整 JSON 对象" };
  const map = normalizeMindMap(parsed, options);
  if (!map) return { map: null, text, usage, error: "JSON 里没有可用的根节点" };
  return { map, text, usage, error: null };
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
  const system = buildSystemPrompt({ kinds, language });
  const plan = planSegments(turns, {
    maxInputTokens: config.maxInputTokens ?? 24000,
    maxBlocks: config.maxBlocks ?? 8,
  });

  if (plan.groups.length === 0) {
    throw new Error("会话里没有可用于生成脑图的内容（没有用户消息或助手回复）。");
  }

  const usage = [];
  let calls = 0;

  const runOnce = async (user, retryNote) => {
    calls += 1;
    const result = await callForMap(callModel, { system, user, options: normalizeOptions, retryNote });
    if (result.usage) usage.push(result.usage);
    return result;
  };

  if (plan.groups.length === 1) {
    const transcript = renderTranscript(plan.groups[0], plan.budget);
    const user = buildUserPrompt({ sessionTitle, transcript, focus });
    let result = await runOnce(user, null);
    if (!result.map) {
      log?.(`首次输出不可用（${result.error}），重试一次`);
      result = await runOnce(user, result.error);
    }
    if (!result.map) {
      throw new Error(`模型两次都没有返回可用的脑图 JSON：${result.error}。可尝试换模型、缩小范围（focus），或调大 maxBlocks。`);
    }
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
      log?.(`第 ${index + 1} 段输出不可用（${result.error}），重试一次`);
      result = await runOnce(user, result.error);
    }
    if (result.map) partials.push(result.map);
    else log?.(`第 ${index + 1} 段放弃：${result.error}`);
  }

  if (partials.length === 0) {
    throw new Error("会话被切成多段后，每一段都没有产出可用的脑图。可尝试换模型或调大 maxInputTokens。");
  }

  // Reduce: merge the partial maps.
  const partialsText = partials
    .map((map, index) => `### 第 ${index + 1} 段\n${JSON.stringify(map)}`)
    .join("\n\n");
  const mergeUser = buildMergePrompt({ sessionTitle, partials: partialsText, language, focus });
  let merged = await runOnce(mergeUser, null);
  if (!merged.map) {
    log?.(`合并输出不可用（${merged.error}），重试一次`);
    merged = await runOnce(mergeUser, merged.error);
  }
  if (!merged.map) {
    // Last resort: keep the first partial map rather than failing the run.
    log?.("合并失败，退化为第 1 段的局部脑图");
    return { map: partials[0], calls, usage, squeezed: plan.squeezed, segments: plan.groups.length };
  }
  return { map: merged.map, calls, usage, squeezed: plan.squeezed, segments: plan.groups.length };
}
