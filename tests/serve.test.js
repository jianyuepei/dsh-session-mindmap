/**
 * The artifact route: whitelist, trust check, and the responses a user sees.
 *
 * The handler is driven with plain request/response stubs — no HTTP server and
 * no DSH — so every branch (method, trust, unknown id, missing file) is covered.
 * The route shape itself was the hard part to get right; see lib/serve.js.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARTIFACT_ROUTE_PATH,
  artifactIdFor,
  artifactUrl,
  createArtifactRegistry,
  handleArtifactRequest,
  isLoopbackAddress,
  isTrustedArtifactRequest,
  registerArtifactRoute,
} from "../lib/serve.js";

const DIRS = [];

/** A temp directory whose lifecycle this suite owns. */
async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), "dsh-mindmap-serve-"));
  DIRS.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(DIRS.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Minimal `ServerResponse` stub that records what was written. */
function fakeResponse() {
  const state = { status: 0, headers: {}, body: undefined, ended: false };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers ?? {};
      return this;
    },
    end(body) {
      state.body = body;
      state.ended = true;
      return this;
    },
  };
}

/** Minimal `IncomingMessage` stub; loopback and same-origin by default. */
function fakeRequest({ method = "GET", url = "/", headers = {}, address = "127.0.0.1" } = {}) {
  return { method, url, headers, socket: { remoteAddress: address } };
}

test("artifact ids are stable per path and links stay same-origin", () => {
  assert.equal(artifactIdFor("/a/b.html"), artifactIdFor("/a/b.html"));
  assert.notEqual(artifactIdFor("/a/b.html"), artifactIdFor("/a/c.html"));
  assert.equal(artifactUrl("abc123"), `${ARTIFACT_ROUTE_PATH}?id=abc123`);
  assert.ok(artifactUrl("abc123").startsWith("/"), "a root-relative link resolves against the app origin");
  assert.equal(ARTIFACT_ROUTE_PATH.startsWith("/api"), false, "the /api namespace belongs to the RPC channel");
});

test("the registry is a whitelist, not a cache", () => {
  const registry = createArtifactRegistry();
  assert.equal(registry.resolve("nope"), undefined);
  const id = registry.remember("/tmp/one.html");
  assert.equal(registry.resolve(id), "/tmp/one.html");
  assert.equal(registry.size(), 1);
  assert.equal(registry.remember("/tmp/one.html"), id, "same path, same id, no duplicate entry");
  assert.equal(registry.size(), 1);
});

test("only this machine, from this origin, may read an artifact", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("localhost"), true);
  assert.equal(isLoopbackAddress("192.168.1.5"), false);
  assert.equal(isLoopbackAddress(undefined), false);

  assert.equal(isTrustedArtifactRequest(fakeRequest()), true);
  assert.equal(isTrustedArtifactRequest(fakeRequest({ address: "10.0.0.9" })), false);
  // A click is a top-level navigation: same-origin or no signal at all.
  assert.equal(isTrustedArtifactRequest(fakeRequest({ headers: { "sec-fetch-site": "same-origin" } })), true);
  assert.equal(isTrustedArtifactRequest(fakeRequest({ headers: { "sec-fetch-site": "none" } })), true);
  assert.equal(isTrustedArtifactRequest(fakeRequest({ headers: { "sec-fetch-site": "cross-site" } })), false);
});

test("a registered artifact is served with the headers a browser needs", async () => {
  const dir = await makeDir();
  const file = join(dir, "map.html");
  await writeFile(file, "<!doctype html><title>x</title>", "utf8");
  const registry = createArtifactRegistry();
  const id = registry.remember(file);

  const res = fakeResponse();
  await handleArtifactRequest(fakeRequest({ url: artifactUrl(id) }), res, { registry });

  assert.equal(res.state.status, 200);
  assert.match(res.state.headers["content-type"], /text\/html/);
  assert.equal(res.state.headers["cache-control"], "no-store");
  assert.match(String(res.state.body), /doctype html/);
});

test("HEAD answers without a body", async () => {
  const dir = await makeDir();
  const file = join(dir, "map.html");
  await writeFile(file, "<!doctype html>", "utf8");
  const registry = createArtifactRegistry();
  const id = registry.remember(file);

  const res = fakeResponse();
  await handleArtifactRequest(fakeRequest({ method: "HEAD", url: artifactUrl(id) }), res, { registry });

  assert.equal(res.state.status, 200);
  assert.equal(res.state.body, undefined);
});

test("a non-loopback or cross-site request is refused before any lookup", async () => {
  let looked = 0;
  const registry = { resolve: () => (looked += 1) };

  for (const request of [
    fakeRequest({ address: "203.0.113.7", url: artifactUrl("x") }),
    fakeRequest({ headers: { "sec-fetch-site": "cross-site" }, url: artifactUrl("x") }),
  ]) {
    const res = fakeResponse();
    await handleArtifactRequest(request, res, { registry });
    assert.equal(res.state.status, 403);
  }
  assert.equal(looked, 0, "refused requests never reach the registry");
});

test("a hard trust failure from the Host is final, a missing app session is not", async () => {
  const dir = await makeDir();
  const file = join(dir, "map.html");
  await writeFile(file, "<!doctype html>", "utf8");
  const registry = createArtifactRegistry();
  const id = registry.remember(file);

  const forbidden = fakeResponse();
  await handleArtifactRequest(fakeRequest({ url: artifactUrl(id) }), forbidden, {
    registry,
    reject: () => 403,
  });
  assert.equal(forbidden.state.status, 403);

  // 401 only means "no app session in this browser"; a top-level navigation is
  // still served, because the loopback + origin check already passed.
  const unauthorized = fakeResponse();
  await handleArtifactRequest(fakeRequest({ url: artifactUrl(id) }), unauthorized, {
    registry,
    reject: () => 401,
  });
  assert.equal(unauthorized.state.status, 200);
});

test("unknown ids, foreign paths and other methods are refused", async () => {
  const registry = createArtifactRegistry();

  const unknown = fakeResponse();
  await handleArtifactRequest(fakeRequest({ url: artifactUrl("deadbeefdeadbeef") }), unknown, { registry });
  assert.equal(unknown.state.status, 404);
  assert.match(String(unknown.state.body), /only works while the session that made it is running/);

  const foreign = fakeResponse();
  await handleArtifactRequest(fakeRequest({ url: "/api/something-else" }), foreign, { registry });
  assert.equal(foreign.state.status, 404);
  assert.match(String(foreign.state.body), /^not found/);

  const post = fakeResponse();
  await handleArtifactRequest(fakeRequest({ method: "POST", url: artifactUrl("x") }), post, { registry });
  assert.equal(post.state.status, 405);
  assert.equal(post.state.headers.allow, "GET, HEAD");
});

test("a registered path that vanished from disk reports rather than throwing", async () => {
  const registry = createArtifactRegistry();
  const id = registry.remember(join(tmpdir(), "dsh-mindmap-missing", "gone.html"));

  const res = fakeResponse();
  await handleArtifactRequest(fakeRequest({ url: artifactUrl(id) }), res, { registry });
  assert.equal(res.state.status, 404);
  assert.match(String(res.state.body), /no longer on disk/);
});

test("a request can never reach the filesystem through the URL", async () => {
  const registry = createArtifactRegistry();
  const res = fakeResponse();
  await handleArtifactRequest(
    fakeRequest({ url: `${ARTIFACT_ROUTE_PATH}?id=${encodeURIComponent("../../etc/passwd")}` }),
    res,
    { registry },
  );
  assert.equal(res.state.status, 404);
});

test("registerArtifactRoute registers an exact route and returns the disposer", () => {
  const registered = [];
  const disposed = [];
  const webServer = {
    register(route) {
      registered.push(route);
      return () => disposed.push(route.path);
    },
  };
  const registry = createArtifactRegistry();
  const dispose = registerArtifactRoute({
    webServer,
    connection: { requestRejection: () => undefined },
    registry,
  });

  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, "exact");
  assert.equal(registered[0].path, ARTIFACT_ROUTE_PATH);
  assert.equal(typeof registered[0].handler, "function");
  dispose();
  assert.deepEqual(disposed, [ARTIFACT_ROUTE_PATH]);
});
