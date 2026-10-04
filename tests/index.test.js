/**
 * Cordis wiring, exercised against the real `@deepseek-ai/dsh-tools`.
 *
 * `defineTool` compiles the author-facing parameter spec and asserts the
 * supported JSON-Schema subset, so this test is what guarantees the tool this
 * plugin registers is actually registrable — the failure would otherwise show
 * up only inside a running DSH.
 *
 * Skipped when the DSH packages are not installed; they are provided by the
 * runtime and are intentionally not devDependencies.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

let plugin = null;
try {
  plugin = await import("../lib/index.js");
} catch {
  plugin = null;
}
const skip = plugin ? false : "@deepseek-ai/dsh-tools is not installed — provided by the DSH runtime";

/** Minimal host: captures what `apply` registers. */
function fakeHost() {
  const tools = [];
  const commands = [];
  const listeners = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    inject(dependencies, callback) {
      if (dependencies.includes("commands")) {
        callback({
          commands: {
            register(definition) {
              commands.push(definition);
              return () => {};
            },
          },
        });
      }
      return () => {};
    },
    get: () => undefined,
    on(name, listener) {
      listeners.push({ name, listener });
      return () => {};
    },
  };
  return { ctx, tools, commands, listeners };
}

test("the module exports the Cordis contract", { skip }, () => {
  assert.equal(plugin.name, "session-mindmap");
  assert.deepEqual(plugin.inject, ["tools"]);
  assert.equal(typeof plugin.apply, "function");
  assert.equal(typeof plugin.Config, "function");
  assert.equal(plugin.NS, "session-mindmap");
});

test("apply registers one tool and one command", { skip }, () => {
  const host = fakeHost();
  plugin.apply(host.ctx, {});

  assert.equal(host.tools.length, 1, "exactly one tool");
  assert.equal(host.commands.length, 1, "exactly one command");

  const tool = host.tools[0];
  assert.equal(tool.name, "session_mindmap");
  assert.ok(tool.description.length > 40);

  // defineTool compiled the property map into a strict JSON Schema.
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["focus", "force", "kinds", "language", "sessionId"]);
  assert.equal(tool.parameters.properties.sessionId.type, "string");
  assert.equal(tool.parameters.properties.force.type, "boolean");
  assert.equal(tool.parameters.required, undefined, "every argument is optional");

  assert.equal(tool.output.schema.type, "object");
  assert.equal(tool.output.schema.additionalProperties, false);
  assert.equal(typeof tool.output.render, "function");

  const blocks = tool.output.render({}, {
    title: "t",
    nodeCount: 1,
    turns: 1,
    model: "m",
    cached: false,
    htmlPath: "/tmp/x.html",
    outline: "- n",
    sessionId: "s",
    calls: 1,
  });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /\/tmp\/x\.html/);

  // 180s per call × (8 map blocks + 2) = 30 minutes, the tool's own ceiling.
  assert.equal(tool.timeoutMs, 1800000);

  const command = host.commands[0];
  assert.equal(command.name, "mindmap");
  assert.ok(command.input.hint.includes("--focus="));
  assert.equal(typeof command.handler, "function");
});

test("the registered tool rejects malformed arguments before running", { skip }, async () => {
  const host = fakeHost();
  plugin.apply(host.ctx, {});
  const tool = host.tools[0];
  await assert.rejects(() => tool.execute({ sessionId: 123 }, {}), /invalid arguments|sessionId/);
  await assert.rejects(() => tool.execute({ force: "yes" }, {}), /invalid arguments|force/);
});

test("a valid call reaches the pipeline and reports a missing host service", { skip }, async () => {
  const host = fakeHost();
  plugin.apply(host.ctx, {});
  const tool = host.tools[0];
  // No sessionQuery in the fake host: the pipeline must say so, not crash.
  await assert.rejects(() => tool.execute({}, {}), /sessionQuery 服务不可用/);
});

test("the command reports failures as an error result", { skip }, async () => {
  const host = fakeHost();
  plugin.apply(host.ctx, {});
  const command = host.commands[0];
  const result = await command.handler({ rawInput: "last", agent: { id: "s" }, signal: undefined });
  assert.equal(result.kind, "error");
  assert.match(result.text, /session-mindmap/);
});
