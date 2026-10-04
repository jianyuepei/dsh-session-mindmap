/**
 * Comparing the mind map of a session with the one generated before it.
 *
 * The point of a "one at the end of each phase" tool is the difference between
 * two runs: what did this phase actually add? That comparison needs no model —
 * two node trees are diffed structurally, by normalised label, so the answer is
 * deterministic and free.
 *
 * Pure module: no `ctx`, no I/O.
 *
 * @module dsh-session-mindmap/diff
 */

/** Labels are compared loosely: case, width and spacing should not matter. */
function keyOf(label) {
  return String(label ?? "")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。；：、,.;:!?！？"'“”‘’()（）[\]【】]/g, "");
}

/** Flatten a map into `key → {label, kind, detail, depth}`. */
function flatten(root) {
  const nodes = new Map();
  const walk = (node, depth) => {
    const key = keyOf(node?.label);
    if (key && !nodes.has(key)) {
      nodes.set(key, {
        label: String(node.label),
        kind: String(node.kind ?? "topic"),
        detail: String(node.detail ?? ""),
        depth,
      });
    }
    for (const child of node?.children ?? []) walk(child, depth + 1);
  };
  if (root) walk(root, 0);
  return nodes;
}

/**
 * Every label in a map, depth-first, deduplicated and bounded.
 *
 * Used as a continuity hint: two runs of the same session only compare
 * meaningfully if the model reuses the wording it chose last time. Real runs
 * produced 40 nodes and then 20 for the same session, so this is not a nicety.
 *
 * @param {{root?: object}|null|undefined} map
 * @param {number} [max=80]
 * @returns {string[]}
 */
export function collectLabels(map, max = 80) {
  const labels = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || labels.length >= max) return;
    const label = String(node.label ?? "").trim();
    const key = keyOf(label);
    if (label && !seen.has(key)) {
      seen.add(key);
      labels.push(label);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(map?.root);
  return labels;
}

/**
 * Diff two mind maps.
 *
 * @param {{root?: object}|null|undefined} previous
 * @param {{root?: object}|null|undefined} current
 * @returns {{
 *   added: Array<{label: string, kind: string}>,
 *   removed: Array<{label: string, kind: string}>,
 *   moved: Array<{label: string, from: number, to: number}>,
 *   retitled: Array<{from: string, to: string}>,
 *   kept: number,
 *   previousTotal: number,
 *   currentTotal: number,
 *   hasChanges: boolean,
 * }}
 */
export function diffMaps(previous, current) {
  const before = flatten(previous?.root);
  const after = flatten(current?.root);

  const added = [];
  for (const [key, node] of after) {
    if (!before.has(key)) added.push({ label: node.label, kind: node.kind });
  }

  const removed = [];
  const moved = [];
  for (const [key, node] of before) {
    const now = after.get(key);
    if (!now) {
      removed.push({ label: node.label, kind: node.kind });
      continue;
    }
    // A depth change means the topic was re-parented: worth surfacing, because
    // it usually means the summary reorganised its own structure.
    if (now.depth !== node.depth) moved.push({ label: node.label, from: node.depth, to: now.depth });
  }

  const retitled = [];
  const previousTitle = String(previous?.title ?? "").trim();
  const currentTitle = String(current?.title ?? "").trim();
  if (previousTitle && currentTitle && keyOf(previousTitle) !== keyOf(currentTitle)) {
    retitled.push({ from: previousTitle, to: currentTitle });
  }

  return {
    added,
    removed,
    moved,
    retitled,
    kept: after.size - added.length,
    previousTotal: before.size,
    currentTotal: after.size,
    hasChanges: added.length > 0 || removed.length > 0 || moved.length > 0 || retitled.length > 0,
  };
}

/**
 * One line describing the delta, for the result text.
 *
 * @param {ReturnType<typeof diffMaps>|undefined} delta
 * @param {"zh"|"en"} language
 * @param {number} [maxLabels=6] - how many node labels to name.
 * @returns {string} empty when there is nothing worth saying.
 */
export function describeDelta(delta, language, maxLabels = 6) {
  if (!delta || !delta.hasChanges) return "";
  const zh = language !== "en";
  const parts = [];
  const name = (items) =>
    items
      .slice(0, maxLabels)
      .map((item) => item.label ?? item.to)
      .join(zh ? "、" : ", ") + (items.length > maxLabels ? (zh ? " 等" : " …") : "");

  if (delta.added.length > 0) {
    parts.push(zh ? `新增 ${delta.added.length} 个话题：${name(delta.added)}` : `+${delta.added.length}: ${name(delta.added)}`);
  }
  if (delta.removed.length > 0) {
    parts.push(zh ? `消失 ${delta.removed.length} 个：${name(delta.removed)}` : `-${delta.removed.length}: ${name(delta.removed)}`);
  }
  if (delta.moved.length > 0) {
    parts.push(zh ? `调整层级 ${delta.moved.length} 个` : `${delta.moved.length} re-parented`);
  }
  if (delta.retitled.length > 0) {
    const [first] = delta.retitled;
    parts.push(zh ? `主题已改为「${first.to}」` : `retitled to "${first.to}"`);
  }
  const head = zh
    ? `与上一次相比：${delta.previousTotal} → ${delta.currentTotal} 个节点`
    : `vs. last run: ${delta.previousTotal} → ${delta.currentTotal} nodes`;
  return `${head}｜${parts.join(zh ? "；" : "; ")}`;
}
