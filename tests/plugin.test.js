/**
 * Registration contract and host-side helpers.
 *
 * The tool/command definitions are plain objects, so this suite proves the
 * contract DSH will register without importing `@deepseek-ai/dsh-tools`.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_CONFIG,
  artifactDir,
  buildCommandDefinition,
  buildToolOptions,
  parseCommandInput,
  resolveConfig,
  resolveKinds,
  resolveModel,
  resolveSessionId,
  stamp,
  summarize,
} from "../lib/plugin.js";

const OK = {
  title: "测试脑图",
  nodeCount: 7,
  turns: 3,
  model: "deepseek/chat",
  cached: false,
  htmlPath: "/tmp/x.html",
  outline: "- 节点",
};

test("parseCommandInput handles ids, flags and unknown tokens", () => {
  assert.deepEqual(parseCommandInput(""), {
    sessionId: "",
    focus: "",
    kinds: "",
    language: "",
    force: false,
    openMode: "",
  });
  assert.deepEqual(parseCommandInput("last --open").openMode, "open");
  assert.equal(parseCommandInput("--reveal").openMode, "reveal");
  assert.equal(parseCommandInput("--no-open").openMode, "none");
  assert.equal(parseCommandInput("--open --no-open").openMode, "none", "the last flag wins");
  const parsed = parseCommandInput("session-abc --focus=脑图 --kinds=topic,todo --lang=en -f");
  assert.equal(parsed.sessionId, "session-abc");
  assert.equal(parsed.focus, "脑图");
  assert.equal(parsed.kinds, "topic,todo");
  assert.equal(parsed.language, "en");
  assert.equal(parsed.force, true);
  assert.equal(parseCommandInput("--focus=a b").sessionId, "b", "a bare token after a flag is still the id");
});

test("resolveKinds intersects with the known kinds and never returns an empty set", () => {
  assert.deepEqual(resolveKinds(["topic", "file"], ""), ["topic", "file"]);
  assert.deepEqual(resolveKinds(["topic"], "todo, nope, todo"), ["todo"]);
  assert.deepEqual(resolveKinds(["topic"], "nope"), [...DEFAULT_CONFIG.kinds]);
  assert.deepEqual(resolveKinds(undefined, ""), [...DEFAULT_CONFIG.kinds]);
});

test("resolveModel prefers config, then the agent default, and fails loudly", () => {
  const ctx = { get: (key) => (key === "agentDefaultModel" ? { currentSelection: () => ({ provider: "p", model: "m" }) } : undefined) };
  assert.deepEqual(resolveModel(ctx, { provider: "a", model: "b" }), { provider: "a", model: "b", source: "config" });
  assert.deepEqual(resolveModel(ctx, {}), { provider: "p", model: "m", source: "default" });
  assert.deepEqual(resolveModel(ctx, { provider: "a" }), { provider: "a", model: "m", source: "default" });
  assert.throws(() => resolveModel({ get: () => undefined }, {}), /无法确定模型/);
});

test("resolveSessionId covers explicit, last and calling-agent cases", async () => {
  const sessionQuery = { listSessions: async () => [{ header: { id: "newest" } }] };
  assert.equal(await resolveSessionId(sessionQuery, "abc", { id: "agent-1" }), "abc");
  assert.equal(await resolveSessionId(sessionQuery, "last", { id: "agent-1" }), "newest");
  assert.equal(await resolveSessionId(sessionQuery, "", { id: "agent-1" }), "agent-1");
  assert.equal(await resolveSessionId(sessionQuery, "", undefined), "newest");
  await assert.rejects(
    () => resolveSessionId({ listSessions: async () => [] }, "last", undefined),
    /找不到任何会话/,
  );
});

test("resolveConfig merges partial config over the defaults", () => {
  assert.deepEqual(resolveConfig({}), { ...DEFAULT_CONFIG });
  const merged = resolveConfig({ maxNodes: 5, language: "en", kinds: ["decision"] });
  assert.equal(merged.maxNodes, 5);
  assert.equal(merged.language, "en");
  assert.deepEqual(merged.kinds, ["decision"]);
  assert.equal(merged.outputDir, DEFAULT_CONFIG.outputDir);
  assert.equal(resolveConfig({ language: "fr" }).language, "zh");
});

test("stamp is a local yyyymmdd-HHMM", () => {
  assert.equal(stamp(new Date(2026, 9, 4, 9, 5)), "20261004-0905");
});

test("summarize reports both languages and the artifact path", () => {
  assert.match(summarize(OK, "zh"), /脑图已生成：测试脑图（7 个节点｜3 轮｜deepseek\/chat）/);
  assert.match(summarize(OK, "en"), /Mind map ready: 测试脑图 \(7 nodes \| 3 turns/);
  assert.match(summarize({ ...OK, cached: true }, "zh"), /缓存命中/);
  assert.match(summarize(OK, "zh"), /文件：\/tmp\/x\.html/);
});

test("summarize turns a served artifact into a clickable link", () => {
  const served = { ...OK, viewPath: "/session-mindmap/artifact?id=abc123" };
  assert.match(summarize(served, "zh"), /▶ \[点击打开脑图\]\(\/session-mindmap\/artifact\?id=abc123\)/);
  assert.match(summarize(served, "en"), /▶ \[Open the mind map\]\(\/session-mindmap\/artifact\?id=abc123\)/);
  // The plain path stays, for terminals and logs.
  assert.match(summarize(served, "zh"), /文件：\/tmp\/x\.html/);
  // Without a served artifact there must be no link at all.
  assert.doesNotMatch(summarize(OK, "zh"), /\]\(/);
});

test("summarize reports what the plugin already did, and the command drops the link", () => {
  const base = { ...OK, htmlPath: "/tmp/x.html" };
  assert.match(summarize({ ...base, opened: "open" }, "zh"), /已用默认浏览器打开/);
  assert.match(summarize({ ...base, opened: "open" }, "en"), /Opened in the default browser/);
  assert.match(summarize({ ...base, opened: "reveal" }, "zh"), /已在文件管理器中选中/);
  assert.doesNotMatch(summarize({ ...base, opened: "none" }, "zh"), /已用默认浏览器/);

  // The GUI's command row renders plain text, so a Markdown link there would be
  // shown literally — it is only offered where text is rendered as Markdown.
  const withLink = { ...base, viewPath: "/session-mindmap/artifact?id=abc" };
  assert.doesNotMatch(summarize(withLink, "zh", { link: false }), /\]\(/);
  assert.match(summarize(withLink, "zh", { link: true }), /点击打开脑图/);
});

test("the command result never contains a markdown link", async () => {
  const definition = buildCommandDefinition({
    config: DEFAULT_CONFIG,
    run: async () => ({ ...OK, viewPath: "/session-mindmap/artifact?id=abc", opened: "open" }),
  });
  const result = await definition.handler({ rawInput: "", agent: { id: "s" }, signal: undefined });
  assert.equal(result.kind, "success");
  assert.doesNotMatch(result.text, /\]\(/);
  assert.match(result.text, /已用默认浏览器打开/);
  assert.match(result.text, /文件：\/tmp\/x\.html/);
});

test("artifactDir resolves the output directory the same way everywhere", () => {
  assert.equal(artifactDir({}, "/work"), "/work/.dsh/mindmap");
  assert.equal(artifactDir({ outputDir: "out" }, "/work"), "/work/out");
  assert.equal(artifactDir({ outputDir: "/abs/out" }, "/work"), "/abs/out");
  assert.equal(artifactDir({}, undefined), join(process.cwd(), ".dsh", "mindmap"));
});

test("the tool contract is complete and self-consistent", () => {
  const options = buildToolOptions({ config: DEFAULT_CONFIG, timeoutMs: 60000, run: async () => OK });
  assert.equal(options.name, "session_mindmap");
  assert.ok(options.description.length > 40);
  assert.deepEqual(Object.keys(options.parameters).sort(), ["focus", "force", "kinds", "language", "sessionId"]);
  assert.equal(options.parameters.sessionId.type, "string");
  assert.equal(options.parameters.force.type, "boolean");
  assert.equal(options.output.schema.type, "object");
  assert.equal(options.output.schema.additionalProperties, false);
  assert.ok(Object.keys(options.output.schema.properties).includes("htmlPath"));
  assert.equal(typeof options.execute, "function");
  assert.equal(typeof options.isConcurrencySafe, "function");

  const blocks = options.output.render({}, OK);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "text");
  assert.match(blocks[0].text, /测试脑图/);

  // `timeoutMs` is validated by defineTool: it must be a positive finite number.
  assert.ok(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0);
});

test("the tool forwards arguments to the pipeline", async () => {
  let received;
  const options = buildToolOptions({
    config: DEFAULT_CONFIG,
    timeoutMs: 1000,
    run: async (args, exec) => {
      received = { args, exec };
      return OK;
    },
  });
  await options.execute({ sessionId: "s2", force: true }, { signal: undefined, agent: { id: "a" } });
  assert.deepEqual(received.args, { sessionId: "s2", force: true });
  assert.equal(received.exec.agent.id, "a");
});

test("the command contract returns success and error results", async () => {
  const definition = buildCommandDefinition({ config: DEFAULT_CONFIG, run: async () => OK });
  assert.equal(definition.name, "mindmap");
  assert.ok(definition.description.length > 0);
  assert.ok(definition.input.hint.includes("--focus"));
  const ok = await definition.handler({ rawInput: "last", agent: { id: "a" }, signal: undefined });
  assert.equal(ok.kind, "success");
  assert.match(ok.text, /脑图已生成/);

  const failing = buildCommandDefinition({
    config: DEFAULT_CONFIG,
    run: async () => {
      throw new Error("模型调用失败");
    },
  });
  const bad = await failing.handler({ rawInput: "", agent: { id: "a" } });
  assert.equal(bad.kind, "error");
  assert.match(bad.text, /session-mindmap: 模型调用失败/);
});
