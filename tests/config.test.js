/**
 * The config schema, validated with the real Schemastery peer.
 *
 * This is the only part of the wiring the Cordis loader type-checks at startup,
 * so it is worth asserting that the defaults ship and that bad values are
 * refused instead of silently coerced.
 *
 * Skipped when the peer is not installed (`npm install` provides it).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG } from "../lib/plugin.js";

let Config = null;
try {
  ({ Config } = await import("../lib/config-schema.js"));
} catch {
  Config = null;
}
const skip = Config ? false : "@deepseek-ai/schemastery is not installed — run `npm install`";

test("Config fills every documented default", { skip }, () => {
  const resolved = Config({});
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.deepEqual(resolved[key], value, `${key} default drifted from DEFAULT_CONFIG`);
  }
});

test("Config keeps explicit overrides", { skip }, () => {
  const resolved = Config({ maxNodes: 5, language: "en", kinds: ["decision"], cache: false });
  assert.equal(resolved.maxNodes, 5);
  assert.equal(resolved.language, "en");
  assert.deepEqual(resolved.kinds, ["decision"]);
  assert.equal(resolved.cache, false);
  assert.equal(resolved.maxDepth, DEFAULT_CONFIG.maxDepth, "untouched keys keep their default");
});

test("Config refuses values outside the contract", { skip }, () => {
  assert.throws(() => Config({ maxNodes: "many" }), /maxNodes/);
  assert.throws(() => Config({ cache: "yes" }), /cache/);
  assert.throws(() => Config({ kinds: 42 }), /kinds/);
  assert.throws(() => Config({ language: 7 }), /language/);
});
