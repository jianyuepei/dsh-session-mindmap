/**
 * The plugin's Config schema.
 *
 * Kept apart from `lib/index.js` so it can be validated without a DSH install:
 * this is the one part of the wiring that the Cordis loader type-checks at
 * startup, so it is worth a real test (see `tests/config.test.js`).
 *
 * The defaults live in `DEFAULT_CONFIG` (lib/plugin.js) and are referenced
 * here, so a default can never drift between the schema and the runtime
 * fallback.
 *
 * @module dsh-session-mindmap/config-schema
 */

import z from "@deepseek-ai/schemastery";

import { DEFAULT_CONFIG } from "./plugin.js";

export const Config = z.object({
  provider: z
    .string()
    .default(DEFAULT_CONFIG.provider)
    .description("LLM provider route; empty follows the agent default model"),
  model: z
    .string()
    .default(DEFAULT_CONFIG.model)
    .description("LLM model id; empty follows the agent default model"),
  kinds: z
    .array(z.string())
    .default([...DEFAULT_CONFIG.kinds])
    .description("Node kinds to extract; add 'file' to include touched files"),
  language: z
    .string()
    .default(DEFAULT_CONFIG.language)
    .description("Mind map language: zh or en"),
  maxInputTokens: z
    .number()
    .default(DEFAULT_CONFIG.maxInputTokens)
    .description("Transcript budget per LLM call"),
  maxBlocks: z
    .number()
    .default(DEFAULT_CONFIG.maxBlocks)
    .description("Hard cap on map calls for a long session (plus one merge call)"),
  maxNodes: z.number().default(DEFAULT_CONFIG.maxNodes).description("Node budget for the final map"),
  maxDepth: z.number().default(DEFAULT_CONFIG.maxDepth).description("Depth budget for the final map"),
  maxOutputTokens: z
    .number()
    .default(DEFAULT_CONFIG.maxOutputTokens)
    .description("maxTokens for one LLM call"),
  temperature: z
    .number()
    .default(DEFAULT_CONFIG.temperature)
    .description("Sampling temperature for the summary calls"),
  llmTimeoutMs: z
    .number()
    .default(DEFAULT_CONFIG.llmTimeoutMs)
    .description("Per-call timeout for the LLM"),
  outputDir: z
    .string()
    .default(DEFAULT_CONFIG.outputDir)
    .description("Artifact directory, relative to the session workspace"),
  cache: z
    .boolean()
    .default(DEFAULT_CONFIG.cache)
    .description("Reuse a previous result while the session has not grown"),
  openAfterBuild: z
    .boolean()
    .default(DEFAULT_CONFIG.openAfterBuild)
    .description("Open the HTML after a human runs /mindmap (model-invoked calls leave a deliverable card)"),
  listLimit: z
    .number()
    .default(DEFAULT_CONFIG.listLimit)
    .description("How many recent sessions `/mindmap list` shows"),
});

export default Config;
