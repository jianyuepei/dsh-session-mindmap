/**
 * Serving a generated artifact back to the browser that asked for it.
 *
 * The point of this module is the difference between "here is a path" and
 * "here is the mind map". A `file://` link cannot be clicked from an http page,
 * and asking the model to run `present` afterwards is not guaranteed, so the
 * plugin serves its own artifact over the Host's web server and hands back a
 * same-origin link.
 *
 * Route shape: an **exact** route plus `?id=…`, the shape the other plugins in
 * this ecosystem use. Two earlier attempts failed against a real boot:
 * - `/api/<anything>` never reaches a plugin route — the Connection RPC channel
 *   claims that namespace and answers first (verified: the request came back as
 *   the SPA 404, not this handler's);
 * - a `prefix` route was equally dead, so the id travels as a query parameter
 *   instead of a path segment.
 *
 * Trust: the artifact is a read-only local file that is already readable on
 * disk, so the bar is "the request came from this machine, from the app's own
 * origin" rather than "the browser proved it holds the process token". The
 * check is explicit and testable, and `connection.requestRejection` is honoured
 * when it reports a hard trust failure (403).
 *
 * Ids are derived from the absolute path, so regenerating an unchanged artifact
 * keeps the same URL, and the registry acts as a whitelist rather than a cache:
 * no part of a request ever reaches the filesystem.
 *
 * @module dsh-session-mindmap/serve
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Exact path owned by this plugin. */
export const ARTIFACT_ROUTE_PATH = "/session-mindmap/artifact";

/** Stable, opaque id for one artifact path. */
export function artifactIdFor(absolutePath) {
  return createHash("sha256").update(String(absolutePath)).digest("hex").slice(0, 16);
}

/** The same-origin link a user can click. */
export function artifactUrl(id) {
  return `${ARTIFACT_ROUTE_PATH}?id=${id}`;
}

/**
 * Whitelist of artifacts this process may serve.
 *
 * @returns {{remember(path: string): string, resolve(id: string): string|undefined, size(): number}}
 */
export function createArtifactRegistry() {
  const paths = new Map();
  return {
    remember(absolutePath) {
      const id = artifactIdFor(absolutePath);
      paths.set(id, absolutePath);
      return id;
    },
    resolve(id) {
      return typeof id === "string" ? paths.get(id) : undefined;
    },
    size() {
      return paths.size;
    },
  };
}

/** Header lookup that tolerates array-valued headers. */
function header(request, name) {
  const value = request?.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Loopback literals, including IPv4-mapped IPv6. */
export function isLoopbackAddress(value) {
  const address = String(value ?? "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    address === "localhost" ||
    address === "localhost." ||
    address === "::1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

/**
 * Whether a request may read an artifact.
 *
 * A link click is a top-level navigation, so the browser sends no `Origin`;
 * `sec-fetch-site` is therefore the only usable cross-site signal, and it is
 * absent on older browsers.
 *
 * @param {object} request - `{ socket, headers }`
 * @returns {boolean}
 */
export function isTrustedArtifactRequest(request) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false;
  const site = header(request, "sec-fetch-site");
  return site === undefined || site === "same-origin" || site === "none";
}

/** Minimal response surface used by the handler (Node's ServerResponse). */
function respond(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

/**
 * Handle one request for an artifact.
 *
 * Exported separately from the route registration so it can be unit-tested with
 * plain request/response stubs.
 *
 * @param {object} req - `{ method, url, headers, socket }`
 * @param {object} res - `{ writeHead(status, headers), end(body) }`
 * @param {object} deps
 * @param {{resolve(id: string): string|undefined}} deps.registry
 * @param {(request: {headers: object}) => 401|403|undefined} [deps.reject]
 * @returns {Promise<void>}
 */
export async function handleArtifactRequest(req, res, { registry, reject }) {
  if (req?.method !== "GET" && req?.method !== "HEAD") {
    respond(res, 405, { ...TEXT_HEADERS, allow: "GET, HEAD" }, "method not allowed\n");
    return;
  }

  // A hard trust failure (wrong Host/Origin) is final; a 401 only means the
  // browser has not established its app session, which a top-level navigation
  // does not require.
  if (reject?.({ headers: req.headers ?? {} }) === 403) {
    respond(res, 403, TEXT_HEADERS, "forbidden\n");
    return;
  }
  if (!isTrustedArtifactRequest(req)) {
    respond(res, 403, TEXT_HEADERS, "forbidden\n");
    return;
  }

  let url;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    respond(res, 400, TEXT_HEADERS, "bad request\n");
    return;
  }
  if (url.pathname !== ARTIFACT_ROUTE_PATH) {
    respond(res, 404, TEXT_HEADERS, "not found\n");
    return;
  }

  const file = registry?.resolve(url.searchParams.get("id") ?? "");
  if (!file) {
    respond(res, 404, TEXT_HEADERS, "not found — this link only works while the session that made it is running\n");
    return;
  }

  const html = await readFile(file).catch(() => null);
  if (html === null) {
    respond(res, 404, TEXT_HEADERS, "the artifact is no longer on disk\n");
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(html.byteLength),
    // The artifact is a snapshot; re-running the command is how you get a new one.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : html);
}

/**
 * Register the artifact route on the Host's web server.
 *
 * @param {object} options
 * @param {object} options.webServer - `ctx.webServer`
 * @param {object} [options.connection] - `ctx.connection`, when the Host has one
 * @param {{resolve(id: string): string|undefined}} options.registry
 * @returns {() => void} disposer
 */
export function registerArtifactRoute({ webServer, connection, registry }) {
  return webServer.register({
    kind: "exact",
    path: ARTIFACT_ROUTE_PATH,
    handler: (req, res) =>
      handleArtifactRequest(req, res, {
        registry,
        reject: (request) => connection?.requestRejection?.(request),
      }),
  });
}
