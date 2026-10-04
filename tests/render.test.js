/** Text renderers and the offline guarantee of the HTML deliverable. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toMarkdown, toMermaid, toOutline } from "../lib/render-md.js";
import { renderHtml } from "../lib/render-html.js";
import { normalizeMindMap } from "../lib/schema.js";

/** Parse the payload back out of a rendered artifact. */
function payload(html) {
  return JSON.parse(html.match(/id="dsh-mindmap-data">([\s\S]*?)<\/script>/)[1]);
}

function sampleMap(label = "会话脑图") {
  return normalizeMindMap(
    {
      title: label,
      root: {
        label: "核心主题",
        children: [
          { label: "结论 A", kind: "conclusion", detail: "因为 X", refs: { seq: [3] } },
          { label: "决策 B", kind: "decision", children: [{ label: "待办 C", kind: "todo" }] },
        ],
      },
    },
    { maxNodes: 40, maxDepth: 4 },
  );
}

test("toMarkdown emits a nested bullet list with kind tags", () => {
  const markdown = toMarkdown(sampleMap(), { sessionId: "s1", model: "m/x", turnCount: 3, language: "zh" });
  assert.match(markdown, /^# 会话脑图\n/);
  assert.match(markdown, /session `s1`/);
  assert.match(markdown, /- 核心主题/);
  assert.match(markdown, /  - 结论 A `结论`/);
  assert.match(markdown, /    - 待办 C `待办`/);
});

test("toMermaid emits a mindmap and strips syntax-breaking characters", () => {
  const map = sampleMap("标题 (含) 括号 [和] `引号`");
  map.root.label = "核心(主题) [带] 括号";
  map.root.children[0].label = "带(括号)的标签";
  const mermaid = toMermaid(map);
  assert.match(mermaid, /^mindmap\n {2}root\(\(/);
  assert.match(mermaid, /root\(\(核心主题 带 括号\)\)/, "the root label is the diagram centre");
  assert.match(mermaid, /带括号的标签/);
  // Only our own root((…)) wrapper may carry shape syntax.
  const body = mermaid.split("\n").slice(2).join("\n");
  assert.doesNotMatch(body, /[()[\]]/, "node labels must not carry mermaid shape syntax");
});

test("toOutline is clipped", () => {
  const map = sampleMap();
  const outline = toOutline(map, 20);
  assert.ok(outline.length <= 20);
  assert.match(outline, /…$/);
});

test("renderHtml produces a self-contained document with the payload embedded", () => {
  const map = sampleMap();
  const markdown = toMarkdown(map);
  const mermaid = toMermaid(map);
  const html = renderHtml({
    map,
    markdown,
    mermaid,
    meta: { sessionId: "s1", model: "m/x", language: "zh", version: "0.1.0", fileBase: "s1-20261004-1200", calls: 2 },
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /id="dsh-mindmap-data"/);
  assert.match(html, /核心主题/);
  assert.match(html, /<style>/);
  assert.match(html, /data-act="png"/);
});

test("renderHtml never references an external resource", () => {
  const html = renderHtml({
    map: sampleMap(),
    markdown: "md",
    mermaid: "mmd",
    meta: { language: "zh", version: "0.1.0", fileBase: "x" },
  });
  assert.doesNotMatch(html, /<script[^>]+src=/i, "no external scripts");
  assert.doesNotMatch(html, /<link\b/i, "no external stylesheets");
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /url\(\s*['"]?https?:/i);
  assert.doesNotMatch(html, /cdn\./i);
});

test("renderHtml cannot be broken out of by hostile node labels", () => {
  const map = sampleMap();
  map.root.children.push({ id: "x", label: "</script><script>globalThis.pwned=1</script>", kind: "topic", refs: { seq: [] }, children: [] });
  const html = renderHtml({
    map,
    markdown: "md",
    mermaid: "mmd",
    meta: { language: "zh", version: "0.1.0", fileBase: "x" },
  });
  assert.doesNotMatch(html, /<\/script><script>globalThis\.pwned/);
  assert.match(html, /\\u003c\/script>/);
  // The only real script close tags are ours.
  assert.equal(html.match(/<\/script>/g).length, 2);
});

test("renderHtml honours the language switch", () => {
  const html = renderHtml({
    map: sampleMap(),
    markdown: "md",
    mermaid: "mmd",
    meta: { language: "en", version: "0.1.0", fileBase: "x" },
  });
  assert.match(html, /<html lang="en"/);
  assert.match(html, /Search nodes/);
});

test("the artifact carries a delta only when there is a previous run", () => {
  const map = sampleMap();
  // The panel markup is static; what decides whether it shows is the payload,
  // which the embedded script reads.
  const withoutDelta = renderHtml({
    map,
    markdown: "md",
    mermaid: "mmd",
    meta: { language: "zh", version: "0.2.0", fileBase: "x" },
  });
  assert.equal(payload(withoutDelta).delta, null);

  const withDelta = renderHtml({
    map,
    markdown: "md",
    mermaid: "mmd",
    meta: {
      language: "zh",
      version: "0.2.0",
      fileBase: "x",
      delta: {
        added: [{ label: "结论 A", kind: "conclusion" }],
        removed: [{ label: "旧话题", kind: "topic" }],
        moved: [{ label: "结论 A", from: 1, to: 2 }],
        retitled: [],
        kept: 3,
        previousTotal: 5,
        currentTotal: 4,
        hasChanges: true,
        previous: { title: "上一次", generatedAt: Date.UTC(2026, 9, 4, 1, 0, 0) },
      },
    },
  });
  assert.match(withDelta, /id="deltaPanel"/);
  assert.match(withDelta, /data-act="delta"/);
  const delta = payload(withDelta).delta;
  assert.notEqual(delta, null);
  assert.deepEqual(delta.added, ["结论 A"]);
  assert.deepEqual(delta.removed, ["旧话题"]);
  assert.equal(delta.movedCount, 1);
  assert.equal(delta.previousTotal, 5);
  assert.equal(delta.currentTotal, 4);
  assert.equal(delta.previousTitle, "上一次");
});
