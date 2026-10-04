/**
 * Prompt construction, stream collection and the map-reduce orchestration.
 *
 * `generateMindMap` takes the model call as an argument, so the whole
 * retry/failure/merge behaviour is testable without a provider.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG } from "../lib/plugin.js";
import { estimateTokens } from "../lib/budget.js";
import { DEFAULT_KINDS } from "../lib/schema.js";
import {
  buildMergePrompt,
  buildSystemPrompt,
  buildUserPrompt,
  collectStream,
  generateMindMap,
  serializePartials,
  NODE_BUDGET,
} from "../lib/organize.js";

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

test("the rubric defines each enabled kind and adapts the self-check", () => {
  const full = buildSystemPrompt({ kinds: [...DEFAULT_KINDS], language: "zh" });
  assert.match(full, /待验证的假设/);
  assert.match(full, /必须把\*\*理由\*\*写进 detail/);
  assert.match(full, /没做完的事、没定的问题/);
  assert.match(full, /那就是漏了，补上再输出/);

  // Only conclusion enabled: no todo/question rules, and no self-check about them.
  const narrow = buildSystemPrompt({ kinds: ["topic", "conclusion"], language: "zh" });
  assert.match(narrow, /conclusion：会话里得出的、有依据的判断/);
  assert.doesNotMatch(narrow, /待验证的假设/);
  assert.doesNotMatch(narrow, /没定的问题/);
  assert.doesNotMatch(narrow, /自检/);

  // A pure topic map needs no rubric at all.
  const topics = buildSystemPrompt({ kinds: ["topic"], language: "zh" });
  assert.doesNotMatch(topics, /判定标准/);
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

test("partial maps are bounded before the merge call", () => {
  const map = {
    title: "段",
    root: { label: "根", kind: "topic", detail: "x".repeat(200), children: [{ label: "子", kind: "todo", detail: "y".repeat(200) }] },
  };
  const small = serializePartials([map, map]);
  assert.match(small, /### 第 1 段/);
  assert.match(small, /### 第 2 段/);
  assert.match(small, /"detail":"x{10}/, "details survive while there is room");

  // Over budget: details go first, structure stays.
  const lean = serializePartials([map, map], 400);
  assert.doesNotMatch(lean, /"detail"/);
  assert.match(lean, /"label":"根"/);
  assert.match(lean, /"kind":"todo"/);

  // Way over budget: truncation is explicit rather than silent.
  const cut = serializePartials([map, map], 60);
  assert.match(cut, /超出预算的部分已截断/);
  assert.ok(cut.length < 200);
});

test("the answer budget fits inside maxOutputTokens (this bug shipped once)", () => {
  // A single answer is bounded by `maxOutputTokens`. Asking for more nodes than
  // the output limit can hold gets the JSON truncated mid-object, which is how
  // `/mindmap` started failing in every session after the rubric was added.
  const worstCase = (nodes, detailChars) =>
    JSON.stringify({
      title: "会话标题".repeat(10),
      root: {
        label: "根节点".repeat(10),
        kind: "topic",
        children: Array.from({ length: nodes }, () => ({
          label: "标".repeat(40),
          kind: "conclusion",
          detail: "细".repeat(detailChars),
          refs: { seq: [123456, 234567] },
          children: [],
        })),
      },
    });

  const mapCase = estimateTokens(worstCase(NODE_BUDGET.map, 120));
  const mergeCase = estimateTokens(worstCase(NODE_BUDGET.merge, NODE_BUDGET.mergeDetailChars));
  const budget = DEFAULT_CONFIG.maxOutputTokens;

  assert.ok(mapCase < budget, `map answer needs ~${mapCase} tokens, budget is ${budget}`);
  assert.ok(mergeCase < budget, `merge answer needs ~${mergeCase} tokens, budget is ${budget}`);

  // And the prompt must actually state those caps, not larger ones.
  const prompt = buildSystemPrompt({ kinds: [...DEFAULT_KINDS], language: "zh" });
  assert.match(prompt, new RegExp(`节点总数\\*\\*不要超过 ${NODE_BUDGET.map} 个`));
  assert.match(prompt, /detail 不超过 120 字/);
  const mergePrompt = buildSystemPrompt({
    kinds: [...DEFAULT_KINDS],
    language: "zh",
    nodeBudget: NODE_BUDGET.merge,
    detailChars: NODE_BUDGET.mergeDetailChars,
  });
  assert.match(mergePrompt, new RegExp(`不要超过 ${NODE_BUDGET.merge} 个`));
  assert.match(mergePrompt, /detail 不超过 60 字/);
});

test("a truncated answer whose JSON cannot be salvaged is retried with a smaller ask", async () => {
  const seen = [];
  const good = JSON.stringify({ title: "x", root: { label: "根", kind: "topic", children: [] } });

  const result = await generateMindMap({
    callModel: async (request) => {
      seen.push(request.user);
      if (seen.length === 1) {
        // Prose only: nothing to repair, and the finish says why.
        return { text: "我先梳理一下这场会话的要点，稍后给出结构化结果。", usage: null, finish: { kind: "max-tokens" } };
      }
      return { text: good, usage: null, finish: { kind: "stop" } };
    },
    sessionTitle: "会话",
    turns: turns(2),
    config: { language: "zh", kinds: [...DEFAULT_KINDS], maxInputTokens: 24000, maxBlocks: 8 },
  });

  assert.equal(result.map.root.label, "根");
  assert.equal(seen.length, 2);
  assert.match(seen[1], /太长被截断/);
  assert.match(seen[1], /不超过 20 个/);
  assert.doesNotMatch(seen[1], /不是合法 JSON/, "the guidance must match the actual failure");
});

test("a JSON answer cut off mid-object is salvaged instead of failing", async () => {
  // The whole point of the repair pass: a truncated map still holds every
  // complete node, so the run succeeds with a slightly shorter map.
  const cut = '{"title":"x","root":{"label":"根","kind":"topic","children":[{"label":"a","kind":"todo"},{"label":"b","kin';
  let calls = 0;
  const result = await generateMindMap({
    callModel: async () => {
      calls += 1;
      return { text: cut, usage: null, finish: { kind: "max-tokens" } };
    },
    sessionTitle: "会话",
    turns: turns(2),
    config: { language: "zh", kinds: [...DEFAULT_KINDS], maxInputTokens: 24000, maxBlocks: 8 },
  });
  assert.equal(calls, 1, "no retry when the answer can be repaired");
  assert.equal(result.map.root.label, "根");
  // Every node that was written out survives, including the one the cut landed
  // in: it kept its label and lost only the fields that never arrived.
  assert.deepEqual(result.map.root.children.map((node) => node.label), ["a", "b"]);
  assert.deepEqual(result.map.root.children.map((node) => node.kind), ["todo", "topic"]);
});

test("two unsalvageable truncated answers produce an actionable error", async () => {
  await assert.rejects(
    () =>
      generateMindMap({
        callModel: async () => ({
          text: "抱歉，这场会话内容较多，我无法在长度限制内输出完整结果。",
          usage: null,
          finish: { kind: "max-tokens" },
        }),
        sessionTitle: "会话",
        turns: turns(2),
        config: { language: "zh", kinds: [...DEFAULT_KINDS], maxInputTokens: 24000, maxBlocks: 8 },
      }),
    (error) => {
      assert.match(error.message, /输出达到 maxOutputTokens，被截断/);
      assert.match(error.message, /调大 maxOutputTokens/);
      assert.match(error.message, /模型输出开头：/);
      return true;
    },
  );
});
