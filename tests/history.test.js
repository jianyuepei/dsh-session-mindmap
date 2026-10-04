/** The per-workspace generation index that makes the delta possible. */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HISTORY_LIMIT, historyPath, previousFor, readHistory, withEntry, writeHistory } from "../lib/history.js";

const DIRS = [];

async function makeDir() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mindmap-history-"));
  DIRS.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(DIRS.map((directory) => rm(directory, { recursive: true, force: true })));
});

/** One index entry. */
function entry(sessionId, capturedThroughSeq, generatedAt = capturedThroughSeq) {
  return {
    sessionId,
    cacheKey: `key-${capturedThroughSeq}`,
    capturedThroughSeq,
    generatedAt,
    title: `t${capturedThroughSeq}`,
    nodeCount: 1,
    language: "zh",
    model: "m/x",
  };
}

test("previousFor picks the newest generation below the current one", () => {
  const entries = [entry("s1", 30), entry("s1", 10), entry("s1", 20), entry("s2", 99)];

  assert.equal(previousFor(entries, "s1", 25).capturedThroughSeq, 20);
  assert.equal(previousFor(entries, "s1", 100).capturedThroughSeq, 30);
  assert.equal(previousFor(entries, "s2", 100).capturedThroughSeq, 99);
  // Nothing older exists yet.
  assert.equal(previousFor(entries, "s1", 10), undefined);
  assert.equal(previousFor(entries, "s3", 100), undefined);
  assert.equal(previousFor([], "s1", 100), undefined);
  assert.equal(previousFor(undefined, "s1", 100), undefined);
});

test("a re-read of the same sequence is not a previous version", () => {
  const entries = [entry("s1", 40)];
  assert.equal(previousFor(entries, "s1", 40), undefined);
});

test("withEntry replaces the same generation and keeps the list newest-first", () => {
  let entries = withEntry([], entry("s1", 1, 100));
  entries = withEntry(entries, entry("s1", 2, 200));
  entries = withEntry(entries, entry("s1", 3, 150));
  assert.deepEqual(entries.map((item) => item.capturedThroughSeq), [2, 3, 1]);

  // Same session + same cache key = the same generation, updated in place.
  const replaced = withEntry(entries, { ...entry("s1", 1, 100), title: "updated" });
  assert.equal(replaced.length, 3);
  assert.equal(replaced.find((item) => item.capturedThroughSeq === 1).title, "updated");
});

test("the index is bounded, dropping the oldest generations", () => {
  let entries = [];
  for (let index = 0; index < HISTORY_LIMIT + 20; index += 1) {
    entries = withEntry(entries, entry("s1", index, index));
  }
  assert.equal(entries.length, HISTORY_LIMIT);
  assert.equal(entries[0].generatedAt, HISTORY_LIMIT + 19, "newest first");
  assert.equal(entries.at(-1).generatedAt, 20, "the oldest fell off");
});

test("read and write round-trip, and a damaged index is just empty", async () => {
  const directory = await makeDir();
  assert.deepEqual(await readHistory(directory), { entries: [] }, "missing index");

  await writeHistory(directory, [entry("s1", 5)]);
  const restored = await readHistory(directory);
  assert.equal(restored.entries.length, 1);
  assert.equal(restored.entries[0].sessionId, "s1");
  assert.ok((await readFile(historyPath(directory), "utf8")).includes("s1"), "written next to the cache");

  await writeFile(historyPath(directory), "{ this is not json", "utf8");
  assert.deepEqual(await readHistory(directory), { entries: [] }, "corrupt index degrades to empty");
});
