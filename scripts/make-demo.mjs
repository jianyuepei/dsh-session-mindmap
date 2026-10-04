/**
 * Regenerate `examples/demo.html` from a canned mind map.
 *
 * The demo exists so a reviewer can open one file and see exactly what the
 * plugin produces without installing anything or spending a model call.
 *
 *   node scripts/make-demo.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderHtml } from "../lib/render-html.js";
import { toMarkdown, toMermaid } from "../lib/render-md.js";
import { normalizeMindMap } from "../lib/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "examples");

/** A realistic map: what this plugin actually returns for a design session. */
const RAW = {
  title: "DSH 会话脑图插件设计",
  root: {
    label: "会话脑图插件",
    kind: "topic",
    detail: "把会话核心内容整理成可离线打开的 HTML 脑图",
    children: [
      {
        label: "需求与边界",
        kind: "topic",
        children: [
          { label: "后置、人工触发，一个阶段生成一次", kind: "topic" },
          { label: "只交付 HTML，不做 GUI 面板", kind: "topic" },
          { label: "不做多会话汇总与自动批量", kind: "topic" },
        ],
      },
      {
        label: "技术约束",
        kind: "topic",
        children: [
          { label: "GUI 没有 Mermaid / markmap 渲染器", kind: "conclusion", detail: "所以图必须由生成的 HTML 自己画" },
          { label: "会话日志是多帧追加的 zstd", kind: "conclusion", detail: "只能走 ctx.sessionQuery，不能直接解压文件" },
        ],
      },
      {
        label: "关键决策",
        kind: "decision",
        detail: "每条都写了理由，方便后来的人理解",
        children: [
          { label: "纯 Host 插件，零构建 ESM JS", kind: "decision", detail: "克隆即可改、即可装，贡献者不需要构建链" },
          { label: "必走 LLM，失败不静默降级", kind: "decision", detail: "长得像脑图的目录树比报错更误导" },
          { label: "读模型表面而不是全量日志", kind: "decision", detail: "更贴近“这个会话到底聊了什么”" },
        ],
      },
      {
        label: "待办",
        kind: "todo",
        children: [
          { label: "在真实会话上跑一遍并人工核对节点质量", kind: "todo" },
          { label: "补一份英文 README 与 CI", kind: "todo" },
        ],
      },
      {
        label: "未决问题",
        kind: "question",
        children: [
          { label: "present 交付的 HTML 能否在 GUI 内预览", kind: "question" },
          { label: "长会话的分段合并质量是否稳定", kind: "question" },
        ],
      },
    ],
  },
};

const map = normalizeMindMap(RAW, { kinds: ["topic", "conclusion", "decision", "todo", "question"], maxNodes: 80, maxDepth: 4 });
if (!map) throw new Error("demo map failed to normalise");

const generatedAt = Date.UTC(2026, 9, 4, 2, 0, 0);
const markdown = toMarkdown(map, {
  sessionId: "session-demo",
  model: "deepseek/chat",
  generatedAt,
  turnCount: 18,
  language: "zh",
});
const mermaid = toMermaid(map);
const html = renderHtml({
  map,
  markdown,
  mermaid,
  meta: {
    sessionId: "session-demo",
    sessionTitle: map.title,
    model: "deepseek/chat",
    generatedAt,
    turnCount: 18,
    language: "zh",
    version: "0.1.0",
    fileBase: "demo",
    calls: 1,
    segments: [
      { index: 1, turn: 1, firstSeq: 1, lastSeq: 205 },
      { index: 2, turn: 1, firstSeq: 209, lastSeq: 245 },
      { index: 3, turn: 2, firstSeq: 254, lastSeq: 300 },
      { index: 4, turn: 3, firstSeq: 309, lastSeq: 1009 },
      { index: 5, turn: 4, firstSeq: 1020, lastSeq: 1199 },
    ],
  },
});

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, "demo.html"), html, "utf8");
await writeFile(join(OUT_DIR, "demo.md"), markdown, "utf8");
await writeFile(join(OUT_DIR, "demo.mmd"), mermaid, "utf8");
process.stdout.write(`demo written to ${OUT_DIR}\n`);
