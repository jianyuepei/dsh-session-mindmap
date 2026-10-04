/**
 * Delivery: opening the artifact, and the deliverable card for tool runs.
 *
 * The card contract is what DSH's client folds (`deliverables/presented` with
 * `{turn, callId, files}`), so it is asserted literally here — a card that never
 * appears is invisible to every other kind of test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendDelivery,
  artifactPathForCwd,
  createDeliveryQueue,
  openCommandFor,
  openTarget,
  queueArtifactDelivery,
} from "../lib/deliver.js";

test("each platform opens or reveals a path the way it expects", () => {
  assert.deepEqual(openCommandFor("darwin", "open", "/tmp/a.html"), { command: "open", args: ["/tmp/a.html"] });
  assert.deepEqual(openCommandFor("darwin", "reveal", "/tmp/a.html"), { command: "open", args: ["-R", "/tmp/a.html"] });
  assert.deepEqual(openCommandFor("win32", "reveal", "C:\\a.html"), { command: "explorer", args: ["/select,C:\\a.html"] });
  assert.deepEqual(openCommandFor("win32", "open", "C:\\a.html"), { command: "cmd", args: ["/c", "start", "", "C:\\a.html"] });
  // Linux has no portable reveal: open the containing directory.
  assert.deepEqual(openCommandFor("linux", "reveal", "/tmp/dir/a.html"), { command: "xdg-open", args: ["/tmp/dir"] });
  assert.deepEqual(openCommandFor("linux", "open", "/tmp/a.html"), { command: "xdg-open", args: ["/tmp/a.html"] });
});

test("openTarget launches the opener once, and does nothing for `none`", () => {
  const launched = [];
  const spawnImpl = (command, args) => {
    launched.push({ command, args });
    return { on() {}, unref() {} };
  };

  assert.equal(openTarget("/tmp/a.html", "none", undefined, spawnImpl), false);
  assert.equal(openTarget("/tmp/a.html", "", undefined, spawnImpl), false);
  assert.equal(launched.length, 0);

  // Platform-independent: on Linux "reveal" opens the containing directory, so
  // the expectation has to come from the same table the implementation uses.
  assert.equal(openTarget("/tmp/a.html", "reveal", undefined, spawnImpl), true);
  const expected = openCommandFor(process.platform, "reveal", "/tmp/a.html");
  assert.equal(launched.length, 1);
  assert.equal(launched[0].command, expected.command);
  assert.deepEqual(launched[0].args, expected.args);
});

test("a failed opener is reported, never thrown", () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };
  const spawnImpl = () => {
    throw new Error("no opener here");
  };
  assert.equal(openTarget("/tmp/a.html", "open", logger, spawnImpl), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no opener here/);
});

test("the delivered path is relative to the session workspace when it lives there", () => {
  assert.equal(artifactPathForCwd("/work", "/work/.dsh/mindmap/a.html"), ".dsh/mindmap/a.html");
  assert.equal(artifactPathForCwd("/work", "/elsewhere/a.html"), "/elsewhere/a.html");
  assert.equal(artifactPathForCwd(undefined, "/work/a.html"), "/work/a.html");
});

test("the delivery event carries exactly what the client folds", () => {
  const appended = [];
  const session = { append: (type, data) => appended.push({ type, data }) };
  const files = [{ path: ".dsh/mindmap/a.html", description: "会话脑图" }];

  assert.equal(appendDelivery({ session, turn: 3, callId: "call-1", files }), true);
  assert.deepEqual(appended, [
    { type: "deliverables/presented", data: { turn: 3, callId: "call-1", files } },
  ]);

  // Guards: no session, no turn, or nothing to deliver.
  assert.equal(appendDelivery({ session: undefined, turn: 3, files }), false);
  assert.equal(appendDelivery({ session, turn: undefined, files }), false);
  assert.equal(appendDelivery({ session, turn: 3, files: [] }), false);
  assert.equal(appended.length, 1);
});

test("an append that throws is contained", () => {
  const warnings = [];
  const session = {
    append() {
      throw new Error("session is closing");
    },
  };
  assert.equal(appendDelivery({ session, turn: 1, files: [{ path: "a" }] }, { warn: (m) => warnings.push(m) }), false);
  assert.match(warnings[0], /session is closing/);
});

test("a tool run inside an open turn is queued as a deliverable", () => {
  const queued = [];
  const session = { header: { cwd: "/work" }, append() {} };
  const ctx = {
    get: (key) =>
      key === "sessionProjections"
        ? { stateOf: () => ({ lastTurn: 4, openTurnStartSeq: 12 }) }
        : undefined,
  };
  const deliveries = { queue: (exec, entry) => queued.push({ exec, entry }) };
  const exec = { callId: "call-9", agent: { session } };

  assert.equal(
    queueArtifactDelivery({
      ctx,
      deliveries,
      exec,
      result: { htmlPath: "/work/.dsh/mindmap/a.html", title: "会话脑图" },
    }),
    true,
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].exec, exec);
  assert.equal(queued[0].entry.turn, 4);
  assert.equal(queued[0].entry.callId, "call-9");
  assert.deepEqual(queued[0].entry.files, [
    { path: ".dsh/mindmap/a.html", description: "会话脑图：会话脑图" },
  ]);
});

test("no delivery is queued without a live session or an open turn", () => {
  const queued = [];
  const deliveries = { queue: (...args) => queued.push(args) };
  const session = { header: { cwd: "/work" }, append() {} };
  const result = { htmlPath: "/work/a.html" };

  // No session at all (headless, subagent).
  assert.equal(
    queueArtifactDelivery({ ctx: { get: () => undefined }, deliveries, exec: {}, result }),
    false,
  );
  // A session but no turn boundary projection.
  assert.equal(
    queueArtifactDelivery({
      ctx: { get: () => undefined },
      deliveries,
      exec: { agent: { session } },
      result,
    }),
    false,
  );
  // A boundary, but the turn is already closed.
  assert.equal(
    queueArtifactDelivery({
      ctx: { get: () => ({ stateOf: () => ({ lastTurn: 2, openTurnStartSeq: null }) }) },
      deliveries,
      exec: { agent: { session } },
      result,
    }),
    false,
  );
  assert.equal(queued.length, 0);
});

test("the queue commits after a successful result and drops failed ones", () => {
  const appended = [];
  const session = { append: (type, data) => appended.push(data) };
  const listeners = {};
  const ctx = {
    on(name, listener) {
      listeners[name] = listener;
      return () => delete listeners[name];
    },
  };
  const queue = createDeliveryQueue();
  queue.attach(ctx);

  const okExec = { id: "ok" };
  const badExec = { id: "bad" };
  queue.queue(okExec, { session, turn: 1, files: [{ path: "a" }] });
  queue.queue(badExec, { session, turn: 1, files: [{ path: "b" }] });
  assert.equal(queue.size(), 2);

  listeners["tools/result"](badExec, { isError: true });
  listeners["tools/result"](okExec, { isError: false });
  listeners["tools/result"]({ id: "unknown" }, { isError: false });

  assert.equal(appended.length, 1, "only the successful result delivers");
  assert.equal(appended[0].files[0].path, "a");
  assert.equal(queue.size(), 0, "entries are consumed either way");
});
