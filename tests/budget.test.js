/** Token budgeting and transcript segmentation. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateTokens, planSegments, renderTranscript, renderTurn, turnCost } from "../lib/budget.js";

/** Build `count` synthetic turns of a given text size. */
function manyTurns(count, chars) {
  const text = "字".repeat(chars);
  return Array.from({ length: count }, (_, index) => ({
    turn: index + 1,
    firstSeq: index * 4 + 1,
    lastSeq: index * 4 + 3,
    user: text,
    assistant: text,
    tools: index % 3 === 0 ? ["read"] : [],
    files: [],
    errors: [],
  }));
}

test("estimateTokens counts CJK per character and latin per four", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("中文测试"), 4);
  assert.equal(estimateTokens("abcd"), 1);
  assert.ok(estimateTokens("中文 abc") > estimateTokens("abc"));
});

test("turnCost and renderTurn respect the character budgets", () => {
  const turn = { turn: 3, firstSeq: 9, lastSeq: 11, user: "u".repeat(100), assistant: "a".repeat(100), tools: ["read"], files: [], errors: [] };
  const text = renderTurn(turn, { userChars: 10, assistantChars: 20 });
  assert.match(text, /## 第 3 轮/);
  assert.match(text, /用户: u{10}$/m);
  assert.match(text, /助手: a{20}$/m);
  assert.match(text, /工具: read/);
  assert.ok(turnCost(turn, { userChars: 10, assistantChars: 20 }) < turnCost(turn, { userChars: 100, assistantChars: 100 }));
});

test("renderTranscript joins turns with a blank line", () => {
  const turns = manyTurns(2, 3);
  const text = renderTranscript(turns, { userChars: 100, assistantChars: 100 });
  assert.equal(text.split("\n\n").length, 2);
});

test("a session inside the budget is one call", () => {
  const plan = planSegments(manyTurns(3, 20), { maxInputTokens: 24000, maxBlocks: 8 });
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.squeezed, false);
});

test("an empty session plans no calls", () => {
  const plan = planSegments([], { maxInputTokens: 1000, maxBlocks: 4 });
  assert.deepEqual(plan.groups, []);
  assert.equal(plan.estimatedTokens, 0);
});

test("an oversized session is squeezed before it is split", () => {
  const turns = manyTurns(100, 4000);
  const plan = planSegments(turns, { maxInputTokens: 5000, maxBlocks: 4 });
  assert.equal(plan.squeezed, true, "must shrink per-turn text");
  assert.ok(plan.budget.userChars < 800);
  assert.equal(plan.groups.length, 4);
  assert.equal(plan.groups.flat().length, turns.length, "no turn may be dropped");
});

test("segmentation never exceeds maxBlocks even with a tiny budget", () => {
  const turns = manyTurns(40, 3000);
  const plan = planSegments(turns, { maxInputTokens: 2000, maxBlocks: 3 });
  assert.equal(plan.groups.length, 3);
  assert.equal(plan.groups.flat().length, 40);
});

test("maxBlocks = 1 keeps a single call even when the session is too big", () => {
  const plan = planSegments(manyTurns(10, 5000), { maxInputTokens: 4000, maxBlocks: 1 });
  assert.equal(plan.groups.length, 1);
});
