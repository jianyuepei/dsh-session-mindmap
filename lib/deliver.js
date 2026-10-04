/**
 * Getting the artifact in front of the user's eyes.
 *
 * Two mechanisms, because the two entry points are different:
 *
 * - **The command** is typed by a human who wants to see the map, so the plugin
 *   opens it (`open`, or `reveal` to select it in the file manager). Nothing to
 *   copy, nothing to click.
 * - **The tool** is called by the model, often mid-task; popping a browser
 *   window would be rude. Instead the plugin appends a `deliverables/presented`
 *   event, exactly the way the first-party `present` tool does, so DSH's own
 *   deliverable card appears with its open/reveal actions. That card is the
 *   reason this module knows about `turnBoundary`.
 *
 * The text result is plain text in the GUI's command row (Markdown is not
 * rendered there), which is why the link alone was not enough.
 *
 * @module dsh-session-mindmap/deliver
 */

import { spawn } from "node:child_process";
import { relative, isAbsolute } from "node:path";

/** Open modes a caller may ask for. */
export const OPEN_MODES = Object.freeze(["none", "open", "reveal"]);

/**
 * The command that opens or reveals a path, per platform.
 *
 * @param {string} platform - `process.platform`
 * @param {"open"|"reveal"} mode
 * @param {string} target
 * @returns {{command: string, args: string[]}}
 */
export function openCommandFor(platform, mode, target) {
  if (platform === "darwin") return { command: "open", args: mode === "reveal" ? ["-R", target] : [target] };
  if (platform === "win32") {
    return mode === "reveal"
      ? { command: "explorer", args: [`/select,${target}`] }
      : { command: "cmd", args: ["/c", "start", "", target] };
  }
  // No portable "reveal" on Linux: open the containing directory instead.
  return mode === "reveal"
    ? { command: "xdg-open", args: [target.replace(/[/\\][^/\\]*$/, "") || "."] }
    : { command: "xdg-open", args: [target] };
}

/**
 * Open (or reveal) a path, fire and forget.
 *
 * @param {string} target
 * @param {"none"|"open"|"reveal"} mode
 * @param {object} [logger]
 * @param {(command: string, args: string[], options: object) => object} [spawnImpl] - test seam.
 * @returns {boolean} whether an opener was launched.
 */
export function openTarget(target, mode, logger, spawnImpl = spawn) {
  if (!target || mode === "none" || !OPEN_MODES.includes(mode)) return false;
  const { command, args } = openCommandFor(process.platform, mode, target);
  try {
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
    child.on?.("error", (error) => logger?.warn?.(`打开文件失败：${error.message}`));
    child.unref?.();
    return true;
  } catch (error) {
    logger?.warn?.(`打开文件失败：${error?.message ?? error}`);
    return false;
  }
}

/** The same artifact as a path the Host's presented-file route can resolve. */
export function artifactPathForCwd(cwd, absolutePath) {
  if (!cwd || !isAbsolute(absolutePath)) return absolutePath;
  const rel = relative(cwd, absolutePath);
  return rel === "" || rel.startsWith("..") ? absolutePath : rel;
}

/**
 * Append one deliverable, mirroring the first-party `present` tool.
 *
 * @param {object} entry
 * @param {object} entry.session - live Session (`exec.agent.session`).
 * @param {number} entry.turn
 * @param {string} [entry.callId]
 * @param {Array<{path: string, description?: string}>} entry.files
 * @param {object} [logger]
 * @returns {boolean} whether the event was appended.
 */
export function appendDelivery({ session, turn, callId, files }, logger) {
  if (!session || typeof session.append !== "function") return false;
  if (!Number.isFinite(turn) || !Array.isArray(files) || files.length === 0) return false;
  try {
    session.append("deliverables/presented", {
      turn,
      ...(callId ? { callId } : {}),
      files,
    });
    return true;
  } catch (error) {
    logger?.warn?.(`交付物事件写入失败：${error?.message ?? error}`);
    return false;
  }
}

/**
 * Queue the artifact of one successful tool run as a deliverable.
 *
 * Skipped, not failed, when there is no live Session or no open turn (a
 * subagent context, a headless run): the plain path in the result still gets
 * the user there.
 *
 * @param {object} options
 * @param {object} options.ctx
 * @param {ReturnType<typeof createDeliveryQueue>} options.deliveries
 * @param {object} options.exec - the tool execution.
 * @param {{htmlPath: string, title?: string}} options.result
 * @param {object} [options.logger]
 * @returns {boolean} whether a delivery was queued.
 */
export function queueArtifactDelivery({ ctx, deliveries, exec, result, logger }) {
  const session = exec?.agent?.session;
  if (!session || !result?.htmlPath) return false;
  const boundary = ctx?.get?.("sessionProjections")?.stateOf?.(session, "turnBoundary");
  if (!boundary || boundary.openTurnStartSeq === null || !Number.isFinite(boundary.lastTurn)) return false;
  const cwd = session.header?.cwd;
  deliveries.queue(exec, {
    session,
    turn: boundary.lastTurn,
    callId: exec.callId,
    files: [
      {
        path: artifactPathForCwd(cwd, result.htmlPath),
        description: result.title ? `会话脑图：${result.title}` : "会话脑图（HTML）",
      },
    ],
  });
  logger?.info?.("已在会话中登记交付物，可在卡片上打开或在文件管理器中显示");
  return true;
}

/**
 * Deliveries waiting for their tool result to commit.
 *
 * The first-party `present` tool appends *after* `tools/result`, not during
 * `execute`; a delivery that lands before the result it belongs to is not what
 * the client folds.
 */
export function createDeliveryQueue() {
  const pending = new Map();
  return {
    queue(exec, entry) {
      if (exec && entry) pending.set(exec, entry);
    },
    attach(ctx, logger) {
      if (typeof ctx?.on !== "function") return () => {};
      return ctx.on("tools/result", (exec, result) => {
        const entry = pending.get(exec);
        pending.delete(exec);
        if (entry === undefined || result?.isError) return;
        appendDelivery(entry, logger);
      });
    },
    size() {
      return pending.size;
    },
  };
}
