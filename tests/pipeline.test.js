/**
 * End-to-end pipeline test with a fake host.
 *
 * Drives read → extract → organise → render → write against a synthetic
 * session, a canned model answer and a temp workspace. No real session content
 * and no network (see README → Privacy).
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMindMap } from "../lib/pipeline.js";
import { createArtifactRegistry, handleArtifactRequest } from "../lib/serve.js";

const T0 = 1_700_000_000_000;

/** Temp workspaces created by this suite, removed in `after`. */
const WORKSPACES = [];

/** A fresh workspace per test keeps the artifact cache from leaking across tests. */
async function makeWorkspace() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-mindmap-test-"));
  WORKSPACES.push(directory);
  return directory;
}

/** A minimal but realistic surface: two turns, one tool call, one failure. */
function surface(capturedThroughSeq, workspace) {
  const ev = (type, seq, data) => ({ type, seq, time: T0 + seq, data });
  return {
    capturedThroughSeq,
    session: { id: "session-test", cwd: workspace, version: 4, createdAt: T0, isSeeded: false },
    events: [
      ev("turn/start", 1, { turn: 1 }),
      ev("user/message", 2, { role: "user", id: "m1", content: [{ type: "text", text: "把这个会话整理成脑图" }] }),
      ev("assistant/message", 3, {
        turn: 1,
        step: 1,
        stream: [],
        message: {
          role: "assistant",
          id: "m2",
          content: [
            { type: "text", text: "先看规范，再定形态。" },
            { type: "tool-call", id: "c1", name: "read", arguments: '{"file_path":"/spec/plugin.md"}' },
          ],
        },
      }),
      ev("turn/start", 4, { turn: 2 }),
      ev("user/message", 5, { role: "user", id: "m3", content: [{ type: "text", text: "就按这个来" }] }),
      ev("assistant/message", 6, {
        turn: 2,
        step: 1,
        stream: [],
        message: { role: "assistant", id: "m4", content: [{ type: "text", text: "已开始实现。" }] },
      }),
      ev("tool/result", 7, {
        turn: 2,
        step: 1,
        message: { role: "tool", id: "m5", content: [{ type: "text", text: "denied" }] },
        error: { name: "ToolError", code: "DENIED" },
      }),
    ],
  };
}

const CANNED = JSON.stringify({
  title: "端到端测试会话",
  root: {
    label: "核心主题",
    kind: "topic",
    children: [
      { label: "关键结论", kind: "conclusion", detail: "先规范后实现", refs: { seq: [3] } },
      { label: "被引用的文件", kind: "file" },
      { label: "下一步", kind: "todo" },
    ],
  },
});

/** Fake `ctx` with only the services the pipeline touches. */
function fakeContext({ answer = () => CANNED, sessions = ["session-test"], captured = 7, workspace } = {}) {
  const state = { streams: 0 };
  const llm = {
    stream() {
      const text = answer(state.streams);
      state.streams += 1;
      return (async function* chunks() {
        yield { type: "text-delta", index: 0, text };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 20 } };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
  const sessionQuery = {
    async listSessions() {
      return sessions.map((id) => ({ header: { id } }));
    },
    async readSurface(id) {
      if (!sessions.includes(id)) throw new Error(`unknown session ${id}`);
      return surface(captured, workspace);
    },
    async readTitle() {
      return { title: "测试会话标题" };
    },
  };
  const ctx = {
    get(key) {
      if (key === "sessionQuery") return sessionQuery;
      if (key === "llm") return llm;
      if (key === "agentDefaultModel") return { currentSelection: () => ({ provider: "fake", model: "chat" }) };
      return undefined;
    },
  };
  return { ctx, state, workspace };
}

/** Read the embedded payload back out of a generated artifact. */
function payloadOf(html) {
  const match = html.match(/id="dsh-mindmap-data">([\s\S]*?)<\/script>/);
  assert.ok(match, "the artifact must embed its payload");
  return JSON.parse(match[1]);
}

/** Minimal `ServerResponse` stub, mirroring tests/serve.test.js. */
function fakeResponse() {
  const state = { status: 0, headers: {}, body: undefined };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers ?? {};
      return this;
    },
    end(body) {
      state.body = body;
      return this;
    },
  };
}

/** Minimal `IncomingMessage` stub; loopback and same-origin by default. */
function fakeRequest({ method = "GET", url = "/", headers = {}, address = "127.0.0.1" } = {}) {
  return { method, url, headers, socket: { remoteAddress: address } };
}

/** Every kind present in a map, depth-first. */
function kindsOf(root) {
  const kinds = [];
  (function walk(node) {
    kinds.push(node.kind);
    for (const child of node.children ?? []) walk(child);
  })(root);
  return kinds;
}

after(async () => {
  await Promise.all(WORKSPACES.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("the pipeline writes a self-contained HTML artifact", async () => {
  const workspace = await makeWorkspace();
  const { ctx, state } = fakeContext({ workspace });
  const result = await runMindMap(ctx, {}, { sessionId: "session-test" });

  assert.equal(result.sessionId, "session-test");
  assert.equal(result.title, "端到端测试会话");
  assert.equal(result.model, "fake/chat");
  assert.equal(result.turns, 2);
  assert.equal(result.cached, false);
  assert.equal(state.streams, 1);
  assert.ok(result.htmlPath.startsWith(join(workspace, ".dsh", "mindmap")));
  assert.ok(existsSync(result.htmlPath), "the artifact must exist");
  assert.equal(result.viewPath, "", "no registry means no link to serve");

  const html = await readFile(result.htmlPath, "utf8");
  assert.match(html, /端到端测试会话/);
  assert.match(html, /关键结论/);
  assert.match(html, /测试会话标题|session-test/);
  assert.match(result.outline, /关键结论/);

  // `file` is not in the default kinds, so it degrades to a topic node.
  assert.ok(!kindsOf(payloadOf(html).map.root).includes("file"), "file nodes stay out unless enabled");
});

test("a registered artifact comes back as a clickable link that serves the file", async () => {
  const workspace = await makeWorkspace();
  const { ctx } = fakeContext({ workspace });
  const registry = createArtifactRegistry();
  const result = await runMindMap(ctx, {}, { sessionId: "session-test", registry });

  assert.match(result.viewPath, /^\/session-mindmap\/artifact\?id=[0-9a-f]{16}$/);

  // The link the user clicks must resolve to the file that was just written.
  const res = fakeResponse();
  await handleArtifactRequest(fakeRequest({ url: result.viewPath }), res, { registry });
  assert.equal(res.state.status, 200);
  assert.equal(Buffer.from(res.state.body).toString("utf8"), await readFile(result.htmlPath, "utf8"));
  assert.match(String(res.state.body), /端到端测试会话/);
});

test("a second run for an unchanged session is served from the cache", async () => {
  const workspace = await makeWorkspace();
  const { ctx, state } = fakeContext({ workspace });
  const first = await runMindMap(ctx, {}, { sessionId: "session-test" });
  const second = await runMindMap(ctx, {}, { sessionId: "session-test" });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(state.streams, 1, "the cache must avoid a second model call");
  assert.ok(existsSync(second.htmlPath), "the second run still writes an artifact");
  assert.equal(await readFile(first.htmlPath, "utf8"), await readFile(second.htmlPath, "utf8"));
});

test("force bypasses the cache", async () => {
  const workspace = await makeWorkspace();
  const { ctx, state } = fakeContext({ workspace });
  await runMindMap(ctx, {}, { sessionId: "session-test" });
  const forced = await runMindMap(ctx, {}, { sessionId: "session-test", force: true });
  assert.equal(forced.cached, false);
  assert.equal(state.streams, 2);
});

test("cache is bypassed when the session has grown", async () => {
  const workspace = await makeWorkspace();
  const first = fakeContext({ captured: 7, workspace });
  await runMindMap(first.ctx, {}, { sessionId: "session-test" });
  const second = fakeContext({ captured: 9, workspace });
  const result = await runMindMap(second.ctx, {}, { sessionId: "session-test" });
  assert.equal(result.cached, false);
  assert.equal(second.state.streams, 1);
});

test("enabling the file kind keeps file nodes", async () => {
  const workspace = await makeWorkspace();
  const { ctx } = fakeContext({ workspace });
  const result = await runMindMap(ctx, {}, { sessionId: "session-test", kinds: "topic,file" });
  const html = await readFile(result.htmlPath, "utf8");
  assert.ok(kindsOf(payloadOf(html).map.root).includes("file"));
});

test("a per-call language override reaches the prompts and the artifact", async () => {
  const workspace = await makeWorkspace();
  const { ctx } = fakeContext({ workspace });
  const prompts = [];
  const englishCtx = {
    get(key) {
      const inner = ctx.get(key);
      if (key !== "llm") return inner;
      return {
        stream(options) {
          prompts.push(options.system);
          return inner.stream(options);
        },
      };
    },
  };

  const result = await runMindMap(englishCtx, {}, { sessionId: "session-test", language: "en" });
  assert.equal(result.language, "en");
  assert.match(prompts[0], /英语/, "the prompt must ask for English nodes");

  const html = await readFile(result.htmlPath, "utf8");
  assert.match(html, /<html lang="en"/);
  assert.match(html, /Copy outline|Fit/);
  assert.deepEqual(payloadOf(html).segments.length > 0, true);
});

test("a session id resolves through `last`", async () => {
  const workspace = await makeWorkspace();
  const { ctx } = fakeContext({ workspace });
  const result = await runMindMap(ctx, {}, { sessionId: "last" });
  assert.equal(result.sessionId, "session-test");
});

test("the calling agent's session is used when no id is given", async () => {
  const workspace = await makeWorkspace();
  const { ctx } = fakeContext({ workspace });
  const result = await runMindMap(ctx, {}, { agent: { id: "session-test" } });
  assert.equal(result.sessionId, "session-test");
});

test("a model that never answers with JSON fails loudly", async () => {
  const workspace = await makeWorkspace();
  const { ctx } = fakeContext({ answer: () => "抱歉，我不太确定。", workspace });
  await assert.rejects(
    () => runMindMap(ctx, {}, { sessionId: "session-test", force: true }),
    /模型两次都没有返回可用的脑图 JSON/,
  );
});

test("a provider error surfaced as a finish reason is reported", async () => {
  const workspace = await makeWorkspace();
  const base = fakeContext({ workspace });
  const ctx = {
    get(key) {
      if (key === "sessionQuery") return base.ctx.get("sessionQuery");
      if (key === "llm") {
        return {
          stream() {
            return (async function* chunks() {
              yield {
                type: "finish",
                reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "too many requests" } },
              };
            })();
          },
        };
      }
      if (key === "agentDefaultModel") return { currentSelection: () => ({ provider: "fake", model: "chat" }) };
      return undefined;
    },
  };
  await assert.rejects(
    () => runMindMap(ctx, {}, { sessionId: "session-test", force: true }),
    /RATE_LIMIT.*too many requests/s,
  );
});

test("a session with nothing to summarise is rejected", async () => {
  const workspace = await makeWorkspace();
  const { ctx } = fakeContext({ workspace });
  const empty = {
    get(key) {
      if (key === "sessionQuery") {
        return {
          ...ctx.get("sessionQuery"),
          readSurface: async () => ({ session: { id: "s", cwd: workspace }, events: [] }),
        };
      }
      return ctx.get(key);
    },
  };
  await assert.rejects(() => runMindMap(empty, {}, { sessionId: "session-test" }), /没有可整理的内容/);
});

test("missing host services produce an actionable error", async () => {
  const workspace = await makeWorkspace();
  await assert.rejects(() => runMindMap({ get: () => undefined }, {}, {}), /sessionQuery 服务不可用/);
  await assert.rejects(
    () => runMindMap({ get: (key) => (key === "sessionQuery" ? fakeContext({ workspace }).ctx.get("sessionQuery") : undefined) }, {}, {}),
    /llm 服务不可用/,
  );
});

test("an oversized session is split into several calls and merged", async () => {
  const workspace = await makeWorkspace();
  const big = JSON.stringify({
    title: "分段",
    root: { label: "根", kind: "topic", children: [{ label: "子", kind: "topic" }] },
  });
  const { ctx, state } = fakeContext({ answer: () => big, workspace });
  const sessionQuery = {
    async listSessions() {
      return [{ header: { id: "session-test" } }];
    },
    async readSurface() {
      const base = surface(7, workspace);
      // Real logs always open a turn; the per-turn blocks depend on it.
      base.events = Array.from({ length: 40 }, (_, index) => [
        {
          type: "turn/start",
          seq: index * 2 + 1,
          time: T0 + index,
          data: { turn: index + 1 },
        },
        {
          type: "assistant/message",
          seq: index * 2 + 2,
          time: T0 + index,
          data: {
            turn: index + 1,
            step: 1,
            stream: [],
            message: { role: "assistant", id: `m${index}`, content: [{ type: "text", text: "很长的内容".repeat(400) }] },
          },
        },
      ]).flat();
      return base;
    },
    async readTitle() {
      return { title: "长会话" };
    },
  };
  const bigCtx = {
    get(key) {
      if (key === "sessionQuery") return sessionQuery;
      return ctx.get(key);
    },
  };
  const result = await runMindMap(bigCtx, { maxInputTokens: 20000, maxBlocks: 3 }, { sessionId: "session-test" });
  assert.ok(state.streams >= 3, `expected map+merge calls, saw ${state.streams}`);
  assert.equal(result.cached, false);
  assert.match(result.outline, /根/);
});

test("a second, longer run reports what the phase added", async () => {
  const workspace = await makeWorkspace();
  const first = fakeContext({ workspace, captured: 7 });
  const firstRun = await runMindMap(first.ctx, {}, { sessionId: "session-test" });
  assert.equal(firstRun.delta, "", "the first run has nothing to compare against");
  assert.equal(firstRun.addedCount, 0);

  // The session grew, and the model now also mentions a new topic.
  const grown = fakeContext({
    workspace,
    captured: 9,
    answer: () =>
      JSON.stringify({
        title: "端到端测试会话",
        root: {
          label: "核心主题",
          kind: "topic",
          children: [
            { label: "关键结论", kind: "conclusion" },
            { label: "新增的话题", kind: "decision" },
          ],
        },
      }),
  });
  const second = await runMindMap(grown.ctx, {}, { sessionId: "session-test" });

  assert.equal(second.addedCount, 1);
  assert.equal(second.removedCount, 2, "the first map had two topics the second one dropped");
  assert.match(second.delta, /与上一次相比/);
  assert.match(second.delta, /新增 1 个话题：新增的话题/);

  const html = await readFile(second.htmlPath, "utf8");
  const payload = payloadOf(html);
  assert.deepEqual(payload.delta.added, ["新增的话题"]);
  assert.deepEqual(payload.delta.removed, ["被引用的文件", "下一步"]);
  assert.equal(payload.delta.previousTotal, 4);
  assert.match(html, /较上次：/);
  assert.match(html, /id="deltaPanel"/);

  // The index remembers both generations, newest first.
  const history = JSON.parse(await readFile(join(workspace, ".dsh", "mindmap", ".cache", "index.json"), "utf8"));
  assert.equal(history.entries.length, 2);
  assert.deepEqual(history.entries.map((row) => row.capturedThroughSeq), [9, 7]);
});

test("the first run still writes an index entry for the next run to find", async () => {
  const workspace = await makeWorkspace();
  const { ctx } = fakeContext({ workspace });
  await runMindMap(ctx, {}, { sessionId: "session-test" });
  const history = JSON.parse(await readFile(join(workspace, ".dsh", "mindmap", ".cache", "index.json"), "utf8"));
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].sessionId, "session-test");
  assert.equal(history.entries[0].capturedThroughSeq, 7);
});
