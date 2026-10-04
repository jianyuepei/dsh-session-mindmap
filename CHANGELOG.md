# Changelog

Notable changes per release. This project follows [semantic versioning](https://semver.org/).

## 0.2.0

### Added

- **Delta against the previous run.** Generating a map for a session that has
  one already reports what the phase added, dropped or re-parented, and the
  artifact highlights the new nodes. Deterministic: it diffs two node trees, it
  does not ask the model anything.
- `/mindmap list` lists recent sessions with their ids and titles, which is how
  you mind-map a session you are not currently in.
- `language` per call (`/mindmap --lang=en`, or the tool's `language` argument).
- Node tooltips say which part of the conversation a node came from
  (`segment 3 · seq 218-245`); the toolbar can copy the outline.
- `--reveal` (select the file in the file manager) and `--no-open` (write quietly).

### Changed

- `/mindmap` opens the artifact when it is done (`openAfterBuild: true`).
- A model-invoked call appends a DSH `deliverables/presented` event, so the
  result appears as a deliverable card with open/reveal actions.
- The command result is plain text and reports what already happened; the
  Markdown link is only emitted where the text is rendered as Markdown.
- Prompt node budget tightened to 35 (45 when merging), and `maxOutputTokens`
  default raised to 8000 so the answer fits.
- README is bilingual with a language switcher; CI checks that the two files
  stay in step.

### Fixed

- **`/mindmap` opens the artifact again.** Routing both entry points through one
  shared request builder had hard-coded the tool's "never pop a window" rule, so
  the command stopped opening the browser and went back to printing a path. The
  two entry points now build their own requests, and both are tested.
- **Truncated answers are no longer a dead end.** The prompt used to ask for
  more nodes than `maxOutputTokens` could hold, so the JSON was cut off and every
  attempt failed with "no usable JSON". Budgets now agree, a truncated object is
  repaired rather than discarded, and the error names the finish reason.
- Turns are reconstructed from the model surface, which has no `turn/start`
  events; a whole session used to collapse into one truncated block.
- Runtime context injected into user messages (`Current runtime context…`,
  `[MNEMON]…`) is stripped before summarising.
- The artifact route lives outside `/api`, which belongs to the RPC channel.

## 0.1.0

- First release: `session_mindmap` tool and `/mindmap` command producing a
  self-contained interactive HTML mind map, with caching, per-kind budgets and
  map-reduce for long sessions.
