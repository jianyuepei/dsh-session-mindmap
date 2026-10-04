/** Comparing two generations of the same session. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDelta, diffMaps } from "../lib/diff.js";
import { normalizeMindMap } from "../lib/schema.js";

/** Build a normalised map from a label tree. */
function map(title, tree) {
  return normalizeMindMap({ title, root: tree }, { maxNodes: 200, maxDepth: 6 });
}

const BEFORE = map("旧标题", {
  label: "根",
  kind: "topic",
  children: [
    { label: "一直有的", kind: "conclusion", children: [{ label: "深处", kind: "todo" }] },
    { label: "这次没了", kind: "todo" },
  ],
});

const AFTER = map("新标题", {
  label: "根",
  kind: "topic",
  children: [
    { label: "一直有的", kind: "conclusion", children: [{ label: "深处", kind: "todo" }] },
    { label: "这次新加的", kind: "decision" },
  ],
});

test("diffMaps reports what a phase actually added and dropped", () => {
  const delta = diffMaps(BEFORE, AFTER);
  assert.deepEqual(delta.added, [{ label: "这次新加的", kind: "decision" }]);
  assert.deepEqual(delta.removed, [{ label: "这次没了", kind: "todo" }]);
  assert.equal(delta.kept, 3);
  assert.equal(delta.previousTotal, 4);
  assert.equal(delta.currentTotal, 4);
  assert.deepEqual(delta.retitled, [{ from: "旧标题", to: "新标题" }]);
  assert.equal(delta.hasChanges, true);
});

test("diffMaps matches labels loosely, so punctuation and case are not changes", () => {
  const before = map("T", { label: "根", children: [{ label: "Hello, World!" }] });
  const after = map("T", { label: "根", children: [{ label: "hello world" }] });
  const delta = diffMaps(before, after);
  assert.equal(delta.added.length, 0);
  assert.equal(delta.removed.length, 0);
  assert.equal(delta.hasChanges, false);
});

test("diffMaps notices a topic that moved to another depth", () => {
  const before = map("T", { label: "根", children: [{ label: "A", children: [{ label: "B" }] }] });
  const after = map("T", { label: "根", children: [{ label: "A" }, { label: "B" }] });
  const delta = diffMaps(before, after);
  assert.deepEqual(delta.moved, [{ label: "B", from: 2, to: 1 }]);
  assert.equal(delta.added.length, 0);
});

test("diffMaps copes with a first run and with an unchanged map", () => {
  assert.deepEqual(diffMaps(undefined, AFTER).added.length, diffMaps(undefined, AFTER).currentTotal);
  assert.equal(diffMaps(undefined, AFTER).previousTotal, 0);
  assert.equal(diffMaps(AFTER, AFTER).hasChanges, false);
  assert.equal(diffMaps(null, null).hasChanges, false);
});

test("describeDelta names the changes, and stays quiet when there are none", () => {
  const zh = describeDelta(diffMaps(BEFORE, AFTER), "zh");
  assert.match(zh, /与上一次相比：4 → 4 个节点/);
  assert.match(zh, /新增 1 个话题：这次新加的/);
  assert.match(zh, /消失 1 个：这次没了/);
  assert.match(zh, /主题已改为「新标题」/);

  const en = describeDelta(diffMaps(BEFORE, AFTER), "en");
  assert.match(en, /vs\. last run: 4 → 4 nodes/);
  assert.match(en, /\+1: 这次新加的/);

  assert.equal(describeDelta(diffMaps(AFTER, AFTER), "zh"), "");
  assert.equal(describeDelta(undefined, "zh"), "");
});

test("describeDelta truncates a long list of changes", () => {
  const before = map("T", { label: "根", children: [] });
  const after = map("T", {
    label: "根",
    children: Array.from({ length: 9 }, (_, index) => ({ label: `新话题 ${index + 1}` })),
  });
  const line = describeDelta(diffMaps(before, after), "zh", 3);
  assert.match(line, /新增 9 个话题：新话题 1、新话题 2、新话题 3 等/);
});

test("collectLabels flattens a map, deduplicates and is bounded", async () => {
  const { collectLabels } = await import("../lib/diff.js");
  assert.deepEqual(collectLabels(BEFORE), ["根", "一直有的", "深处", "这次没了"]);
  // Deduplication is by normalised key, so "A" and "a" are the same topic.
  assert.deepEqual(collectLabels({ root: { label: "A", children: [{ label: "b" }, { label: "b" }] } }), ["A", "b"]);
  assert.deepEqual(collectLabels({ root: { label: "A", children: [{ label: "a" }] } }), ["A"]);
  assert.deepEqual(collectLabels(undefined), []);
  assert.equal(collectLabels(BEFORE, 2).length, 2);
});
