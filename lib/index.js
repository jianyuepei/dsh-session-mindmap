/**
 * dsh-session-mindmap — Cordis plugin entry.
 *
 * This file is only the wiring: the config schema, the tool registration and
 * the command registration. The behaviour lives in `lib/pipeline.js` (no DSH
 * imports, fully testable) and the model contract in `lib/plugin.js`.
 *
 * Design notes worth knowing before editing:
 * - There is deliberately **no client half**, no GUI panel and no build step.
 *   DSH's web GUI ships no diagram renderer, so the picture is drawn by the
 *   generated HTML itself.
 * - Session logs on disk are multi-frame zstd appends; they are never read
 *   directly. `ctx.sessionQuery` is the only supported source.
 * - A model failure is reported, never silently replaced by a rule-based
 *   outline: a mind map that is not a mind map is worse than an error.
 *
 * @module dsh-session-mindmap
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

import { Config } from "./config-schema.js";
import { runMindMap } from "./pipeline.js";
import { DEFAULT_CONFIG, buildCommandDefinition, buildToolOptions } from "./plugin.js";

/** Cordis plugin name. */
const name = "session-mindmap";
/** Services that must exist before `apply` runs; everything else is resolved lazily. */
const inject = ["tools"];
/** Row id / settings key — keep in sync with cordis.patch.yml. */
const NS = "session-mindmap";


/**
 * Cordis plugin entry.
 * @param {object} ctx
 * @param {object} [config]
 */
function apply(ctx, config) {
  const resolved = config ?? {};
  const perCallTimeout = Number.isFinite(resolved.llmTimeoutMs)
    ? resolved.llmTimeoutMs
    : DEFAULT_CONFIG.llmTimeoutMs;
  const maxBlocks = Number.isFinite(resolved.maxBlocks) ? resolved.maxBlocks : DEFAULT_CONFIG.maxBlocks;
  const timeoutMs = Math.max(60000, Math.ceil(perCallTimeout * (maxBlocks + 2)));

  const run = (args, exec) =>
    runMindMap(ctx, resolved, {
      sessionId: args.sessionId,
      kinds: args.kinds,
      focus: args.focus,
      force: args.force === true,
      open: args.open === true,
      signal: exec?.signal,
      agent: exec?.agent,
    });

  ctx.tools.register(defineTool(buildToolOptions({ config: resolved, timeoutMs, run })));

  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register(
      buildCommandDefinition({
        config: resolved,
        run: (parsed, invocation) => run(parsed, { signal: invocation?.signal, agent: invocation?.agent }),
      }),
    );
  });
}

export { Config, NS, apply, inject, name };
