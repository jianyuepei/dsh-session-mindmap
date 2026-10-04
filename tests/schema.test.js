/** Mind-map parsing and clamping — the untrusted-model-output boundary. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_KINDS, NODE_KINDS, countNodes, extractJsonObject, normalizeMindMap, walk } from "../lib/schema.js";

test("NODE_KINDS and the default selection stay in sync", () => {
  for (const kind of DEFAULT_KINDS) assert.ok(NODE_KINDS.includes(kind), `${kind} must be a known kind`);
  assert.ok(!DEFAULT_KINDS.includes("file"), "'file' is opt-in by design");
});

test("extractJsonObject reads fenced, bare and prose-wrapped answers", () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('好的，结果如下：\n{"a":{"b":"}"}}\n以上。'), { a: { b: "}" } });
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject('{"a":'), null);
  assert.equal(extractJsonObject(""), null);
  assert.equal(extractJsonObject(undefined), null);
});

test("normalizeMindMap coerces fields, filters kinds and de-duplicates siblings", () => {
  const map = normalizeMindMap(
    {
      title: "  测试  会话 ",
      root: {
        label: "主题",
        children: [
          { label: "结论 A", kind: "conclusion", detail: "  因为  X  " },
          { label: "结论 a", kind: "conclusion" },
          { label: "神秘", kind: "not-a-kind" },
          { label: "", kind: "todo" },
        ],
      },
    },
    { kinds: [...DEFAULT_KINDS], maxNodes: 50, maxDepth: 4 },
  );
  assert.equal(map.title, "测试 会话");
  assert.equal(map.root.label, "主题");
  assert.equal(map.root.kind, "topic");
  assert.deepEqual(map.root.children.map((node) => node.label), ["结论 A", "神秘"]);
  assert.equal(map.root.children[0].kind, "conclusion");
  assert.equal(map.root.children[0].detail, "因为 X");
  assert.equal(map.root.children[1].kind, "topic", "unknown kinds fall back to topic");
});

test("normalizeMindMap clamps node and depth budgets", () => {
  const wide = { label: "root", children: Array.from({ length: 40 }, (_, i) => ({ label: `c${i}` })) };
  const clamped = normalizeMindMap(wide, { maxNodes: 10, maxDepth: 4 });
  assert.equal(countNodes(clamped.root), 10);
  assert.equal(clamped.truncated, true);

  const deep = { label: "root", children: [{ label: "a", children: [{ label: "b", children: [{ label: "c", children: [{ label: "d" }] }] }] }] };
  const shallow = normalizeMindMap(deep, { maxNodes: 80, maxDepth: 2 });
  assert.deepEqual(
    (() => {
      const depths = [];
      walk(shallow.root, (_node, depth) => depths.push(depth));
      return depths;
    })(),
    [0, 1],
  );
  assert.equal(shallow.truncated, true);
});

test("normalizeMindMap keeps at most 20 distinct seq refs and drops junk", () => {
  const map = normalizeMindMap(
    { root: { label: "r", refs: { seq: [3, 3, -1, "x", 1, ...Array.from({ length: 30 }, (_, i) => i + 10)] } } },
    { maxNodes: 10, maxDepth: 2 },
  );
  assert.ok(map.root.refs.seq.length <= 20);
  assert.deepEqual(map.root.refs.seq.slice(0, 2), [3, 1]);
  assert.ok(map.root.refs.seq.every((seq) => Number.isInteger(seq) && seq >= 0));
});

test("normalizeMindMap rejects answers with no usable root", () => {
  assert.equal(normalizeMindMap(null), null);
  assert.equal(normalizeMindMap({ root: { label: "   " } }), null);
  assert.equal(normalizeMindMap({ root: "not an object" }), null);
  assert.equal(normalizeMindMap({ title: "只有标题" }), null);
});

test("normalizeMindMap accepts a bare node as the root", () => {
  const map = normalizeMindMap({ label: "直接给根" }, { maxNodes: 5, maxDepth: 2 });
  assert.equal(map.root.label, "直接给根");
  assert.equal(map.title, "会话脑图");
});
