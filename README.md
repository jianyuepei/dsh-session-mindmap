# dsh-session-mindmap

**English** · [简体中文](README.zh-CN.md)

[![CI](https://github.com/jianyuepei/dsh-session-mindmap/actions/workflows/ci.yml/badge.svg)](https://github.com/jianyuepei/dsh-session-mindmap/actions/workflows/ci.yml)

**Turn a DeepSeek Harness session into a self-contained HTML mind map.**

At the end of a work phase, run `/mindmap` and get one portable file that shows
what the session was actually about: topics, conclusions, decisions with their
reasons, todos and open questions. Open it in any browser, hand it to someone
else, or file it away — the file needs no network, no fonts and no CDN.

![demo](examples/demo.png)

## Why this exists

A long session is a terrible artifact: the interesting parts (what was decided,
what was rejected and why, what is still unresolved) are spread over dozens of
turns, and reading the transcript again is rarely worth it. This plugin produces
the one-page version.

It is deliberately **not** a GUI panel, not an automation, and not a knowledge
base: it runs when you ask it to, writes one file, and stops.

## Install

```sh
# from npm
dsh plugin add dsh-session-mindmap

# from a checkout (development)
dsh plugin add /path/to/dsh-session-mindmap

# from git (lib/ is committed, so no build step runs)
dsh plugin add github:jianyuepei/dsh-session-mindmap
```

Requires DSH **0.2.0-rc.2** (`dsh --version`). The plugin manager refuses to
install when the declared peer versions do not match the running DSH; upgrade
DSH rather than forcing an exemption if you can.

## Usage

Ask the model:

> 把这个会话整理成脑图

or call the tool yourself:

```
session_mindmap
  sessionId?  "last" or a session id; defaults to the current session
  kinds?      CSV of topic,conclusion,decision,todo,question,file
  focus?      only summarise this topic
  language?   zh or en; defaults to the plugin config
  force?      ignore the cache and call the model again
```

or use the command, which never involves the model in deciding anything:

```
/mindmap                       # current session
/mindmap last                  # most recent session
/mindmap session-abc --reveal  # a specific session, then select it in the file manager
/mindmap --no-open             # write the file quietly
/mindmap --focus=发布方案       # only one topic
/mindmap --kinds=topic,file    # include the files that were touched
/mindmap --lang=en             # one English map, without touching the config
/mindmap list                  # recent sessions with their ids and titles
```

The command is the intended entry point: it runs even when you do not want to
spend a model turn on the request itself.

## Output

```
<session workspace>/.dsh/mindmap/
├── <sessionId>-<yyyymmdd-HHMM>.html   # the deliverable
└── .cache/<hash>.json                 # map + exports, keyed by session state
```

* **One click away.** The result carries a same-origin link
  (`/session-mindmap/artifact?id=…`) instead of only a path, so the mind map
  opens in the browser directly. The file path stays on its own line for
  terminals, logs and headless runs. Links are process-scoped — they work while
  the DSH instance that generated them is running, which is the same lifetime
  the app's own token URLs have.
* **The HTML is standalone.** No CDN, no web fonts, no images, no telemetry.
  It draws the map with inline SVG, so the file still works offline and can be
  attached to a chat or committed.
* **What changed since last time.** Generating a map for a session that already
  has one reports the delta — `13 → 18 nodes · +6 · -1` — lists the added and
  dropped topics, marks the new nodes in the artifact, and puts the same line in
  the result. It is a structural diff of two node trees: no model call, no cost,
  and the same input always gives the same answer. The previous run's node
  labels are handed back to the model with "reuse this wording", because two
  runs otherwise describe the same topic differently and the diff becomes noise.
  The bookkeeping lives in `.cache/index.json`.
* **Interactions**: fold nodes, drag to pan, scroll to zoom, search to
  highlight, hover to see which part of the conversation a node came from
  (`segment 3 · seq 218-245`), copy the outline, and export to PNG / Markdown /
  Mermaid from the toolbar.
* **Cache**: keyed by the session's captured event sequence, the enabled kinds,
  the focus, the language and the model. Re-running an unchanged session skips
  the model call entirely; `force: true` (or `--force`) bypasses it.
* **Regenerating** writes a new timestamped file, so older snapshots stay put.
  Add `.dsh/` to `.gitignore` if you do not want them committed.

## Configuration

Set these in the plugin row (profile `cordis.patch.yml`) — a patch replaces the
whole `config` object, so restate every key you want to keep:

```yaml
- id: session-mindmap
  name: 'dsh-session-mindmap'
  config:
    language: en
    maxNodes: 120
```

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` / `model` | empty | Empty follows the agent's default model. Point these at a cheap model if you generate these often. |
| `kinds` | `topic, conclusion, decision, todo, question` | Node kinds to extract. Add `file` to include the files a session touched. |
| `language` | `zh` | Node language: `zh` or `en` (the `language` tool argument overrides it for one run). |
| `maxInputTokens` | `24000` | Transcript budget for one model call. |
| `maxBlocks` | `8` | Hard cap on map calls for a long session, plus one merge call. |
| `maxNodes` / `maxDepth` | `80` / `4` | Clamps applied to whatever the model returns. |
| `maxOutputTokens` / `temperature` | `8000` / `0.2` | Per-call generation settings. A node costs roughly (label + detail) characters, so this cap has to hold the whole answer — see Troubleshooting. |
| `llmTimeoutMs` | `180000` | Per-call timeout. |
| `outputDir` | `.dsh/mindmap` | Relative to the session workspace; absolute paths are accepted. |
| `cache` | `true` | Reuse the last result while the session has not grown. |
| `openAfterBuild` | `true` | Open the artifact after a human runs `/mindmap`. Ignored for model-invoked calls, which leave a deliverable card instead. |

## How it works

```
sessionQuery.readSurface(id)        the context the model actually saw
        ↓  extract.js               events → one block per turn (pure)
        ↓  budget.js                token estimate → 1 call, or ≤maxBlocks + 1 (pure)
        ↓  organize.js              ctx.llm.stream → strict JSON, one retry (pure)
        ↓  schema.js                coerce, clamp, de-duplicate (pure)
        ↓  render-html.js           self-contained HTML with an inline SVG renderer
   <workspace>/.dsh/mindmap/*.html
```

Three decisions are worth knowing about, because they are the ones a reviewer
usually asks about:

* **No Mermaid.** DSH's web GUI ships no diagram renderer (no Mermaid, no
  markmap — verified by scanning the app bundle), so a ```` ```mermaid ````
  block would render as plain code. The picture is drawn by the generated file
  itself. Mermaid is offered as an *export*, for tools that do render it.
* **Sessions are read through `ctx.sessionQuery`.** The on-disk log is a
  multi-frame zstd append (one measured session held 136 frames), so
  decompressing it directly yields only the first frame. The service is the only
  supported source, and `readSurface` is the closest thing to "what this session
  was about".
* **A model failure is an error, not a fallback.** If the model does not return
  usable JSON after one retry, the run fails with a clear message instead of
  writing an artifact that merely *looks* like a mind map. A silent rule-based
  outline is the kind of output people would trust without noticing it is not
  what they asked for.

## Privacy

* The plugin reads sessions through the host service and sends the transcript to
  **the model you already configured**. Nothing is sent anywhere else.
* Artifacts are written to the session's own workspace.
* The test suite contains **no real session content**: every fixture is
  synthetic. Please keep it that way.

## Compatibility

| | |
| --- | --- |
| DSH | `0.2.0-rc.2` (older releases are refused by the plugin manager) |
| Node | `>= 20.18` |
| Profiles | desktop and web (host-side plugin; no client bundle) |
| Build | none — the published `lib/` is plain ESM, committed to git |

## Development

```sh
npm install          # one dev mirror (schemastery); the DSH packages come in as peers
npm test             # node:test, 77 tests, no network, no DSH install needed
npm run demo         # regenerate examples/demo.{html,md,mmd}
```

Tests come in three layers, and the middle one is the point:

1. **Pure logic** — `extract`, `budget`, `schema`, `render-*`: no host, no I/O.
2. **Wiring contract** — `tests/index.test.js` runs `apply` against the real
   `@deepseek-ai/dsh-tools`, proving the registered tool compiles and validates
   its arguments. It *skips* (rather than failing) when the DSH packages are
   unreachable, so a contributor without them can still run everything else.
3. **Pipeline** — `tests/pipeline.test.js` drives read → organise → render →
   write with a fake host, a canned model answer and a temp workspace.

```
lib/index.js          Cordis wiring: Config, tool, command
lib/config-schema.js  Schemastery schema (tested against the real peer)
lib/plugin.js         Host seams with no DSH imports: tool/command contracts, helpers
lib/pipeline.js       read → extract → organise → render → write (no DSH imports)
lib/extract.js        event log → per-turn blocks
lib/budget.js         token estimate + segmentation
lib/organize.js       prompts, streaming, strict-JSON parsing, map-reduce
lib/schema.js         mind-map model: parse, coerce, clamp
lib/render-md.js      Markdown / Mermaid / outline
lib/render-html.js    the standalone deliverable
scripts/make-demo.mjs regenerates examples/
```

## Troubleshooting

**`模型两次都没有返回可用的脑图 JSON` / "the model did not return usable mind-map JSON".**
Read the first line of the error — it names the finish reason:

* *output hit maxOutputTokens* — the answer was cut off because it did not fit.
  Raise `maxOutputTokens`, or ask for less (`--kinds=topic,conclusion`,
  `--focus=…`, a smaller `maxNodes`). A truncated answer is *not* always lost:
  everything written before the cut is parsed, so the map comes back slightly
  shorter and the log says so.
* anything else — the model answered with prose or a malformed object. Try
  another model (`provider`/`model`), or narrow the session with `focus`.

The node budget in the prompt (`NODE_BUDGET` in `lib/organize.js`) and
`maxOutputTokens` have to agree: asking for more nodes than the output limit can
hold is what produced a wall of "no valid JSON" errors once. A test asserts the
two stay in sync.

## Contributing

Issues and PRs are welcome. Three ground rules:

* keep the plugin **host-only and build-free** — no client half, no bundler, no
  new runtime dependency;
* keep real session content out of tests and issues;
* **keep this file and [README.zh-CN.md](README.zh-CN.md) in sync** — they are
  two translations of one document, not two documents.

Please run `npm test` and `npm run demo` before opening a PR; CI checks both and
fails if `examples/` is stale.

## License

MIT

---

[⬆ Back to top](#dsh-session-mindmap) · [简体中文](README.zh-CN.md)
