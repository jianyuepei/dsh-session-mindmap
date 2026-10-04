/**
 * Prompt construction, stream collection and the map-reduce orchestration.
 *
 * `generateMindMap` takes the model call as an argument, so the whole
 * retry/failure/merge behaviour is testable without a provider.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_KINDS } from "../lib/schema.js";
import { buildMergePrompt, buildSystemPrompt, buildUserPrompt, collectStream, generateMindMap } from "../lib/organize.js";

/** A model answer shaped like the prompt asks for. */
const GOOD = JSON.stringify({
  title: "标题",
  root: { label: "根", kind: "topic", children: [{ label: "子", kind: "conclusion" }] },
});

/** One turn of transcript, big enough to force segmentation when asked. */
function turns(count, chars = 10) {
  return Array.from({ length: count }, (_, index) => ({
    turn: index + 1,
    firstSeq: index * 4 + 1,
    lastSeq: index * 4 + 3,
    user: "问".repeat(chars),
    assistant: "答".repeat(chars),
    tools: [],
    files: [],
    errors: [],
  }));
}

test("the system prompt switches the file rule with the enabled kinds", () => {
  const withoutFile = buildSystemPrompt({ kinds: [...DEFAULT_KINDS], language: "zh" });
  assert.match(withoutFile, /本次不需要文件维度/);
  assert.doesNotMatch(withoutFile, /放进 `file` 节点/);

  const withFile = buildSystemPrompt({ kinds: [...DEFAULT_KINDS, "file"], language: "zh" });
  assert.match(withFile, /放进 `file` 节点/);
  assert.doesNotMatch(withFile, /本次不需要文件维度/);
});

test("the user prompt carries the session title, focus and part marker", () => {
  const plain = buildUserPrompt({ sessionTitle: "会话 A", transcript: "记录" });
  assert.match(plain, /会话标题：会话 A/);
  assert.match(plain, /会话记录：\n记录/);
  assert.doesNotMatch(plain, /第 \d+\/\d+ 段/);

  const partial = buildUserPrompt({ sessionTitle: "会话 A", transcript: "记录", part: 2, total: 3, focus: "发布" });
  assert.match(partial, /只围绕「发布」整理/);
  assert.match(partial, /第 2\/3 段/);
});

test("the merge prompt lists the partial maps", () => {
  const prompt = buildMergePrompt({ sessionTitle: "会话 A", partials: "### 第 1 段\n{}", language: "zh" });
  assert.match(prompt, /合并成一张完整的脑图/);
  assert.match(prompt, /### 第 1 段/);
});

test("collectStream assembles text, usage and finish", async () => {
  const stream = async function* () {
    yield { type: "text-delta", index: 0, text: "你好" };
    yield { type: "text-delta", index: 0, text: "，世界" };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } };
    yield { type: "finish", reason: { kind: "stop" } };
  };
  const result = await collectStream(() => stream(), {});
  assert.equal(result.text, "你好，世界");
  assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 2 });
  assert.equal(result.finish.kind, "stop");
});

test("collectStream turns failure finish reasons into errors", async () => {
  const stream = async function* () {
    yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "slow down" } } };
  };
  await assert.rejects(() => collectStream(() => stream(), {}), /RATE_LIMIT.*slow down/s);

  const aborted = async function* () {
    yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "cancelled" } } };
  };
  await assert.rejects(() => collectStream(() => aborted(), {}), /模型调用失败/);
});

test("a session inside the budget needs one call", async () => {
  const calls = [];
  const result = await generateMindMap({
    callModel: async (request) => {
      calls.push(request);
      return { text: GOOD, usage: null };
    },
    sessionTitle: "会话",
    turns: turns(3),
    config: { language: "zh", kinds: [...DEFAULT_KINDS], maxInputTokens: 24000, maxBlocks: 8 },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.calls, 1);
  assert.equal(result.segments, 1);
  assert.equal(result.map.root.children[0].label, "子");
  assert.match(calls[0].system, /会话复盘助手/);
});

test("an unusable answer is retried once and then reported", async () => {
  let attempt = 0;
  const retry = await generateMindMap({
    callModel: async () => {
      attempt += 1;
      return { text: attempt === 1 ? "我不确定" : GOOD, usage: null };
    },
    sessionTitle: "会话",
    turns: turns(2),
    config: { language: "zh", kinds: [...DEFAULT_KINDS], maxInputTokens: 24000, maxBlocks: 8 },
  });
  assert.equal(attempt, 2);
  assert.match(retry.map.root.label, /根/);

  let attempts = 0;
  await assert.rejects(
    () =>
      generateMindMap({
        callModel: async () => {
          attempts += 1;
          return { text: "还是没有 JSON", usage: null };
        },
        sessionTitle: "会话",
        turns: turns(2),
        config: { language: "zh", kinds: [...DEFAULT_KINDS], maxInputTokens: 24000, maxBlocks: 8 },
      }),
    /模型两次都没有返回可用的脑图 JSON/,
  );
  assert.equal(attempts, 2);
});

test("an oversized session maps in parts and merges them", async () => {
  const seen = [];
  const result = await generateMindMap({
    callModel: async (request) => {
      seen.push(request.user);
      return { text: GOOD, usage: null };
    },
    sessionTitle: "长会话",
    turns: turns(60, 400),
    config: { language: "zh", kinds: [...DEFAULT_KINDS], maxInputTokens: 4000, maxBlocks: 3 },
  });
  // 3 map calls + 1 merge call.
  assert.equal(seen.length, 4);
  assert.equal(result.segments, 3);
  assert.match(seen[3], /合并成一张完整的脑图/);
  assert.equal(result.map.root.label, "根");
});

test("a failed merge degrades to the first partial map instead of failing", async () => {
  let call = 0;
  const result = await generateMindMap({
    callModel: async () => {
      call += 1;
      const isMerge = call > 3;
      return { text: isMerge ? "合并失败" : GOOD, usage: null };
    },
    sessionTitle: "长会话",
    turns: turns(60, 400),
    config: { language: "zh", kinds: [...DEFAULT_KINDS], maxInputTokens: 4000, maxBlocks: 3 },
  });
  assert.equal(result.map.root.label, "根");
  assert.equal(result.segments, 3);
});

test("an empty turn list is refused before any model call", async () => {
  await assert.rejects(
    () =>
      generateMindMap({
        callModel: async () => ({ text: GOOD, usage: null }),
        sessionTitle: "空",
        turns: [],
        config: { language: "zh", kinds: [...DEFAULT_KINDS], maxInputTokens: 24000, maxBlocks: 8 },
      }),
    /没有可用于生成脑图的内容/,
  );
});
