/**
 * Text renderers: mind map → Markdown and → Mermaid.
 *
 * Single source of truth for both export formats. The HTML deliverable embeds
 * the strings produced here instead of re-implementing the emitters in the
 * browser, so the exported files can never drift from the CLI behaviour.
 *
 * @module dsh-session-mindmap/render-md
 */

import { KIND_LABELS } from "./schema.js";

/** Escape characters that would break Mermaid mind-map node text. */
function mermaidText(label) {
  return String(label ?? "")
    .replace(/[[\](){}`"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * Render the map as a nested Markdown bullet list.
 * @param {{title:string, root:object}} map
 * @param {object} [meta] - `{sessionId, model, generatedAt, turnCount, language}`
 * @returns {string}
 */
export function toMarkdown(map, meta = {}) {
  const language = meta.language === "en" ? "en" : "zh";
  const lines = [`# ${map.title}`];
  const facts = [];
  if (meta.sessionId) facts.push(`session \`${meta.sessionId}\``);
  if (Number.isFinite(meta.turnCount)) facts.push(language === "en" ? `${meta.turnCount} turns` : `${meta.turnCount} 轮`);
  if (meta.model) facts.push(`model \`${meta.model}\``);
  if (meta.generatedAt) facts.push(new Date(meta.generatedAt).toISOString().slice(0, 16).replace("T", " "));
  if (facts.length > 0) lines.push("", `> ${facts.join(" · ")}`);

  const emit = (node, depth) => {
    const indent = "  ".repeat(depth);
    const kindLabel = KIND_LABELS[language][node.kind] ?? node.kind;
    const suffix = node.kind === "topic" || depth === 0 ? "" : ` \`${kindLabel}\``;
    lines.push(`${indent}- ${node.label}${suffix}`);
    if (node.detail && depth > 0) lines.push(`${indent}  ${node.detail}`);
    for (const child of node.children ?? []) emit(child, depth + 1);
  };
  emit(map.root, 0);
  return `${lines.join("\n")}\n`;
}

/**
 * Render the map as a Mermaid `mindmap` diagram.
 * @param {{title:string, root:object}} map
 * @returns {string}
 */
export function toMermaid(map) {
  const center = mermaidText(map.root.label) || mermaidText(map.title) || "mindmap";
  const lines = ["mindmap", `  root((${center}))`];
  const emit = (node, depth) => {
    lines.push(`${"  ".repeat(depth + 1)}${mermaidText(node.label)}`);
    for (const child of node.children ?? []) emit(child, depth + 1);
  };
  for (const child of map.root.children ?? []) emit(child, 1);
  return `${lines.join("\n")}\n`;
}

/**
 * One-line-per-node plain outline, for tool results and quick inspection.
 * @param {{root:object}} map
 * @param {number} [maxChars=3000]
 * @returns {string}
 */
export function toOutline(map, maxChars = 3000) {
  const lines = [];
  const emit = (node, depth) => {
    lines.push(`${"  ".repeat(depth)}- ${node.label}${node.detail ? ` — ${node.detail}` : ""}`);
    for (const child of node.children ?? []) emit(child, depth + 1);
  };
  emit(map.root, 0);
  const text = lines.join("\n");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
