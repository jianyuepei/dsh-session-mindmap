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
import {
  DEFAULT_CONFIG,
  LOG,
  buildCommandDefinition,
  buildToolOptions,
  commandRequest,
  listRecentSessions,
  toolRequest,
} from "./plugin.js";
import { createArtifactRegistry, registerArtifactRoute, ARTIFACT_ROUTE_PATH } from "./serve.js";
import { createDeliveryQueue, queueArtifactDelivery } from "./deliver.js";

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

  /** Whitelist of artifacts this process is allowed to serve back to the browser. */
  const registry = createArtifactRegistry();
  /** Deliverables waiting for their tool result to commit (see lib/deliver.js). */
  const deliveries = createDeliveryQueue();
  const logger = ctx.logger?.(LOG);
  // Registered on this plugin's fiber, like every other contribution.
  deliveries.attach(ctx, logger);

  // Two entry points, two request builders: a model-invoked call never opens a
  // window (it leaves a deliverable card), a human-typed command does.
  const runTool = async (args, exec) => {
    const result = await runMindMap(ctx, resolved, toolRequest(args, exec, { registry }));
    if (exec !== undefined) queueArtifactDelivery({ ctx, deliveries, exec, result, logger });
    return result;
  };

  const runCommand = (parsed, invocation) =>
    runMindMap(ctx, resolved, commandRequest(parsed, invocation, resolved, { registry }));

  ctx.tools.register(defineTool(buildToolOptions({ config: resolved, timeoutMs, run: runTool })));

  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register(
      buildCommandDefinition({
        config: resolved,
        list: () => listRecentSessions(ctx.get("sessionQuery"), { limit: resolved.listLimit || 10, language: resolved.language }),
        run: runCommand,
      }),
    );
  });

  // Serve generated artifacts so results carry a clickable link instead of a
  // path to copy. Registered whenever the Host has a web server; the handler
  // does its own loopback/same-origin check and treats a missing `connection`
  // as "no extra gate" rather than as a reason to skip the feature.
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => {
      const disposer = registerArtifactRoute({
        webServer: webCtx.webServer,
        connection: ctx.get("connection"),
        registry,
      });
      ctx.logger?.(LOG)?.info?.(`脑图链接路由已注册：${ARTIFACT_ROUTE_PATH}`);
      return disposer;
    });
  });
}

export { Config, NS, apply, inject, name };
