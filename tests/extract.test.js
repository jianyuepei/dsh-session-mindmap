/**
 * Contract + pure-logic tests for the pieces that do not need a DSH install.
 *
 * Everything here runs from a clean checkout: no `ctx`, no network, no real
 * session data (see README → Privacy).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { blocksToText, clip, collectTurns, filePathsFromToolArgs, stripInjectedContext, toolCallsInMessage } from "../lib/extract.js";

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

test("collectTurns splits turns on the model surface, which has no turn/start", () => {
  // `sessionQuery.readSurface` returns message-surface events only: no
  // `turn/start`, no `turn/end`. The turn number on assistant/tool events is
  // the only boundary signal, and a user message after produced output opens a
  // new turn. Getting this wrong collapses a whole session into one block,
  // which the per-turn character budget then silently truncates.
  const surface = [
    ev("user/message", 1, { role: "user", content: [{ type: "text", text: "第一轮问题" }] }),
    ev("assistant/message", 2, {
      turn: 1,
      step: 1,
      stream: [],
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "第一轮回答" },
          { type: "tool-call", id: "c1", name: "read", arguments: '{"file_path":"/a.md"}' },
        ],
      },
    }),
    ev("tool/result", 3, { turn: 1, step: 1, message: { role: "tool", content: [{ type: "text", text: "ok" }] } }),
    ev("user/message", 4, { role: "user", content: [{ type: "text", text: "第二轮问题" }] }),
    ev("assistant/message", 5, {
      turn: 2,
      step: 1,
      stream: [],
      message: { role: "assistant", content: [{ type: "text", text: "第二轮回答" }] },
    }),
    ev("user/message", 6, { role: "user", content: [{ type: "text", text: "第三轮问题" }] }),
    ev("assistant/message", 7, {
      turn: 3,
      step: 1,
      stream: [],
      message: { role: "assistant", content: [{ type: "text", text: "第三轮回答" }] },
    }),
  ];
  const { turns } = collectTurns(surface);
  assert.equal(turns.length, 3, "the surface must not collapse into one turn");
  assert.deepEqual(turns.map((turn) => turn.turn), [1, 2, 3], "explicit turn numbers win");
  assert.deepEqual(turns.map((turn) => turn.user), ["第一轮问题", "第二轮问题", "第三轮问题"]);
  assert.deepEqual(turns.map((turn) => turn.assistant), ["第一轮回答", "第二轮回答", "第三轮回答"]);
  assert.deepEqual(turns[0].tools, ["read"]);
  assert.deepEqual(turns[0].files, ["/a.md"]);
});

test("collectTurns splits turns by alternation when nothing carries a turn number", () => {
  const events = [
    ev("user/message", 1, { role: "user", content: [{ type: "text", text: "a" }] }),
    ev("assistant/message", 2, { message: { role: "assistant", content: [{ type: "text", text: "A" }] } }),
    ev("user/message", 3, { role: "user", content: [{ type: "text", text: "b" }] }),
    ev("assistant/message", 4, { message: { role: "assistant", content: [{ type: "text", text: "B" }] } }),
  ];
  const { turns } = collectTurns(events);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.user), ["a", "b"]);
  assert.deepEqual(turns.map((turn) => turn.assistant), ["A", "B"]);
});

test("back-to-back user messages stay in one turn", () => {
  const events = [
    ev("user/message", 1, { role: "user", content: [{ type: "text", text: "先看这个" }] }),
    ev("user/message", 2, { role: "user", content: [{ type: "text", text: "顺便也看那个" }] }),
    ev("assistant/message", 3, { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "都看了" }] } }),
  ];
  const { turns } = collectTurns(events);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user, "先看这个\n顺便也看那个");
});

test("a later turn number that does not match the block opens a new one", () => {
  const events = [
    ev("assistant/message", 1, { turn: 7, message: { role: "assistant", content: [{ type: "text", text: "七" }] } }),
    ev("assistant/message", 2, { turn: 8, message: { role: "assistant", content: [{ type: "text", text: "八" }] } }),
  ];
  const { turns } = collectTurns(events);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.turn), [7, 8]);
});

test("stripInjectedContext drops runtime boilerplate but keeps the user's words", () => {
  const real = "把这个会话整理成脑图";
  const boilerplate = "Current runtime context. This snapshot supersedes earlier snapshots.";
  assert.equal(stripInjectedContext(`${real}\n${boilerplate}`), real, "trailing injection is cut");
  assert.equal(stripInjectedContext(boilerplate), "", "a pure boilerplate message contributes nothing");
  assert.equal(stripInjectedContext(`  ${real}  `), real);
  assert.equal(stripInjectedContext("MNEMON RUNTIME MEMORY SNAPSHOT\nRevision: abc"), "");
  assert.equal(stripInjectedContext(`${real}\n[MNEMON] Search Documents for…`), real);
  assert.equal(stripInjectedContext(""), "");
  assert.equal(stripInjectedContext(undefined), "");
});

test("runtime boilerplate does not open a turn of its own", () => {
  const events = [
    ev("user/message", 1, { role: "user", content: [{ type: "text", text: "真正的需求" }] }),
    ev("user/message", 2, { role: "user", content: [{ type: "text", text: "Current runtime context. Snapshot…" }] }),
    ev("assistant/message", 3, { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "收到" }] } }),
  ];
  const { turns } = collectTurns(events);
  assert.equal(turns.length, 1, "injected context must not split the turn");
  assert.equal(turns[0].user, "真正的需求");
});

test("collectTurns numbers blocks by transcript position", () => {
  const events = [
    ev("user/message", 1, { role: "user", content: [{ type: "text", text: "一" }] }),
    ev("assistant/message", 2, { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "A" }] } }),
    ev("user/message", 3, { role: "user", content: [{ type: "text", text: "二" }] }),
    ev("assistant/message", 4, { turn: 2, message: { role: "assistant", content: [{ type: "text", text: "B" }] } }),
  ];
  const { turns } = collectTurns(events);
  assert.deepEqual(turns.map((turn) => turn.index), [1, 2]);
  assert.deepEqual(turns.map((turn) => turn.turn), [1, 2]);
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
