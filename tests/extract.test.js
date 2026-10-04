/**
 * Contract + pure-logic tests for the pieces that do not need a DSH install.
 *
 * Everything here runs from a clean checkout: no `ctx`, no network, no real
 * session data (see README → Privacy).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { blocksToText, clip, collectTurns, filePathsFromToolArgs, toolCallsInMessage } from "../lib/extract.js";

const T0 = 1_700_000_000_000;

/** Build one synthetic session event. */
function ev(type, seq, data = {}) {
  return { type, seq, time: T0 + seq, data };
}

/** A two-turn synthetic session: one clean turn, one with a denied tool call. */
function fixture() {
  return [
    ev("turn/start", 1, { turn: 1 }),
    ev("user/message", 2, { role: "user", id: "m1", content: [{ type: "text", text: "我想写一个 DSH 插件" }] }),
    ev("developer/message", 3, { turn: 1, step: 1, message: { role: "developer", id: "m2", content: [] } }),
    ev("assistant/message", 4, {
      turn: 1,
      step: 1,
      stream: [],
      message: {
        role: "assistant",
        id: "m3",
        content: [
          { type: "reasoning", text: "内部推理不该进摘要" },
          { type: "text", text: "先把开发规范找出来。" },
          { type: "tool-call", id: "c1", name: "read", arguments: '{"file_path":"/tmp/spec.md","limit":50}' },
          { type: "tool-call", id: "c2", name: "grep", arguments: '{"pattern":"mindmap","path":"/tmp"}' },
        ],
      },
    }),
    ev("tool/result", 5, { turn: 1, step: 1, message: { role: "tool", id: "m4", content: [{ type: "text", text: "ok" }] } }),
    ev("turn/end", 6, { turn: 1, reason: { kind: "completed" } }),
    ev("turn/start", 7, { turn: 2 }),
    ev("user/message", 8, { role: "user", id: "m5", content: [{ type: "text", text: "那就按这个设计来" }] }),
    ev("assistant/message", 9, {
      turn: 2,
      step: 1,
      stream: [],
      message: {
        role: "assistant",
        id: "m6",
        content: [
          { type: "text", text: "我先改配置文件。" },
          { type: "tool-call", id: "c3", name: "edit", arguments: '{"file_path":"/tmp/package.json"}' },
        ],
      },
    }),
    ev("tool/result", 10, {
      turn: 2,
      step: 1,
      message: { role: "tool", id: "m7", content: [{ type: "text", text: "denied" }] },
      error: { name: "ToolError", code: "DENIED" },
    }),
    ev("turn/end", 11, { turn: 2, reason: { kind: "completed" } }),
    ev("session/end-seed", 12, {}),
  ];
}

test("blocksToText keeps text blocks and drops everything else", () => {
  assert.equal(blocksToText([{ type: "text", text: "a" }, { type: "reasoning", text: "b" }, { type: "text", text: "c" }]), "a\nc");
  assert.equal(blocksToText("plain"), "plain");
  assert.equal(blocksToText(undefined), "");
  assert.equal(blocksToText([{ type: "tool-call", id: "x", name: "read", arguments: "{}" }]), "");
});

test("clip collapses whitespace and adds an ellipsis only when it truncates", () => {
  assert.equal(clip("a\n\n\n\nb", 100), "a\n\nb");
  assert.equal(clip("  hello  ", 100), "hello");
  assert.equal(clip("abcdef", 4), "abc…");
  assert.equal(clip("abcdef", 6), "abcdef");
});

test("filePathsFromToolArgs collects known path keys only", () => {
  assert.deepEqual(filePathsFromToolArgs('{"file_path":"/a","other":"/b"}'), ["/a"]);
  assert.deepEqual(filePathsFromToolArgs('{"files":[{"path":"/c"}]}'), ["/c"]);
  assert.deepEqual(filePathsFromToolArgs("not json"), []);
  assert.deepEqual(filePathsFromToolArgs('{"pattern":"x"}'), []);
  // `path` is only trusted when it names a file, not a search root.
  assert.deepEqual(filePathsFromToolArgs('{"path":"/tmp"}'), []);
  assert.deepEqual(filePathsFromToolArgs('{"path":"/a/b.md"}'), ["/a/b.md"]);
});

test("toolCallsInMessage reads tool-call blocks from an assistant message", () => {
  const { names, files } = toolCallsInMessage({
    content: [
      { type: "text", text: "hi" },
      { type: "tool-call", id: "c1", name: "read", arguments: '{"file_path":"/a.md"}' },
      { type: "tool-call", id: "c2", name: "read", arguments: '{"file_path":"/b.md"}' },
    ],
  });
  assert.deepEqual(names, ["read"]);
  assert.deepEqual(files, ["/a.md", "/b.md"]);
});

test("collectTurns folds the log into turns and ignores plumbing events", () => {
  const { turns, eventCount, ignored } = collectTurns(fixture());
  assert.equal(turns.length, 2);
  assert.equal(eventCount, 12);
  assert.ok(ignored > 0, "developer/system/seed events must not become turns");

  assert.equal(turns[0].turn, 1);
  assert.match(turns[0].user, /我想写一个 DSH 插件/);
  assert.match(turns[0].assistant, /先把开发规范找出来/);
  assert.doesNotMatch(turns[0].assistant, /内部推理/);
  assert.deepEqual(turns[0].tools, ["read", "grep"]);
  // `grep {"path":"/tmp"}` is a search root, not an involved file.
  assert.deepEqual(turns[0].files, ["/tmp/spec.md"]);
  assert.equal(turns[0].firstSeq, 1);
  assert.equal(turns[0].lastSeq, 6, "the turn's own turn/end belongs to it");

  assert.equal(turns[1].turn, 2);
  assert.deepEqual(turns[1].errors, ["ToolError: DENIED"]);
  assert.deepEqual(turns[1].files, ["/tmp/package.json"]);
});

test("collectTurns drops turns that carry nothing worth summarising", () => {
  const events = [ev("turn/start", 1, { turn: 1 }), ev("turn/end", 2, { turn: 1, reason: { kind: "completed" } })];
  assert.equal(collectTurns(events).turns.length, 0);
});

test("collectTurns tolerates out-of-order and malformed events", () => {
  const events = [
    ev("user/message", 5, { role: "user", content: [{ type: "text", text: "second" }] }),
    ev("user/message", 1, { role: "user", content: [{ type: "text", text: "first" }] }),
    { type: "user/message" },
    null,
  ];
  const { turns } = collectTurns(events);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user, "first\nsecond");
});
