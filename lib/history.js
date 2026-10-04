/**
 * What this workspace has already generated.
 *
 * The delta against the previous run needs to find that run's map. Cache file
 * names are content hashes, so the lookup lives in a small index next to them:
 * one read instead of scanning hundreds of cache files.
 *
 * The selection logic is pure and tested; only the two I/O helpers touch disk.
 *
 * @module dsh-session-mindmap/history
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Index file name inside the artifact directory's `.cache/`. */
export const HISTORY_FILE = "index.json";

/** Keep the index bounded; oldest generations fall off the end. */
export const HISTORY_LIMIT = 500;

/** Where the index lives for one artifact directory. */
export function historyPath(directory) {
  return join(directory, ".cache", HISTORY_FILE);
}

/**
 * The generation that came before the one now being written.
 *
 * "Previous" means: same session, a strictly smaller captured sequence, and the
 * newest such entry. A run that re-read the same sequence is not a previous
 * version of anything.
 *
 * @param {Array<object>} entries
 * @param {string} sessionId
 * @param {number} beforeSeq
 * @returns {object|undefined}
 */
export function previousFor(entries, sessionId, beforeSeq) {
  let best;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.sessionId !== sessionId) continue;
    const seq = Number(entry.capturedThroughSeq);
    if (!Number.isFinite(seq)) continue;
    if (Number.isFinite(beforeSeq) && seq >= beforeSeq) continue;
    if (best === undefined || seq > Number(best.capturedThroughSeq)) best = entry;
  }
  return best;
}

/**
 * Insert or replace one generation, newest first and bounded.
 *
 * @param {Array<object>} entries
 * @param {object} entry - `{sessionId, cacheKey, capturedThroughSeq, generatedAt, title, nodeCount, language, model}`
 * @returns {Array<object>} the new list.
 */
export function withEntry(entries, entry) {
  const key = `${entry.sessionId}::${entry.cacheKey}`;
  const rest = (Array.isArray(entries) ? entries : []).filter(
    (candidate) => `${candidate?.sessionId}::${candidate?.cacheKey}` !== key,
  );
  const next = [entry, ...rest].sort((a, b) => Number(b.generatedAt ?? 0) - Number(a.generatedAt ?? 0));
  return next.slice(0, HISTORY_LIMIT);
}

/**
 * Read the index; a missing or corrupt file is simply an empty history.
 *
 * @param {string} directory - artifact directory (not `.cache`).
 * @returns {Promise<{entries: object[]}>}
 */
export async function readHistory(directory) {
  const parsed = await readFile(historyPath(directory), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  return { entries: Array.isArray(parsed?.entries) ? parsed.entries : [] };
}

/**
 * Write the index back, creating `.cache/` when needed.
 *
 * @param {string} directory
 * @param {object[]} entries
 * @returns {Promise<void>}
 */
export async function writeHistory(directory, entries) {
  await mkdir(join(directory, ".cache"), { recursive: true });
  await writeFile(historyPath(directory), JSON.stringify({ version: 1, entries }, null, 2), "utf8");
}
