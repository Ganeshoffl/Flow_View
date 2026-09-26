# flow_view — project rules

Binding constraints for all work in this repository. They come from the product decisions recorded in
`.kiro/specs/flow-view/requirements.md` and exist to keep the architecture from eroding.

## Architecture

- **The Universal Trace is the only contract** between execution and visualization
  (`.kiro/specs/flow-view/trace-schema.md`). Adapters produce it; renderers consume it. Neither may
  import from, or know anything about, the other.
- An adapter change that requires a renderer change — or the reverse — is a design bug. Fix the
  contract, do not couple the sides.
- `packages/trace-schema` is the single source of truth. TypeScript types and Python dataclasses are
  generated from the JSON Schema. Never hand-edit generated output.
- Adding a language means writing one adapter and changing no UI code.
  Adding a view means writing one renderer and changing no adapter.

## Hard constraints

- **No network calls at runtime. Ever.** No external APIs, no API keys, no LLM inference, no
  telemetry, no CDN fetches at run time. The tool must work fully offline and air-gapped.
- **No mid-run state editing.** Playback is read-only replay of recorded history.
- Narration is generated from trace events by deterministic templates — never by a model.
- The program is never re-executed for playback. Backward stepping inverts recorded events.

## Honesty

Never fabricate. Specifically:

- A value the runtime cannot report is `unavailable` with a reason — never a guess.
- Structure inference carries a confidence level and its evidence, and is always user-overridable.
  Inference may be wrong; it may never hide data. Unknown shapes fall back to a generic object graph.
- A truncated trace reports where and why it stopped, and remains usable.
- Sandbox guards that are not active on the current platform are reported as inactive. Never imply
  protection that is not in force.
- A missing toolchain disables exactly one language, with an actionable message. It never breaks the tool.

## Working method

- Phases come from `.kiro/specs/flow-view/tasks.md` and each ends at a **gate**. Code that exists but
  cannot be demonstrated is not done. Do not start a phase before the previous gate passes.
- Every adapter must pass the shared `conformance/` suite, including the invertibility check: replaying
  forward to the end and then inverting back to zero must restore the initial state exactly.
- Every emitted trace validates against the schema in CI.
- Performance budgets are requirements, not aspirations: step/back-step under 50 ms at p95 for 100k
  retained steps; heap view at 30 fps for 500 visible nodes.

## Environment notes

- Default sandbox is a resource-limited subprocess. Docker is opt-in via `FLOW_VIEW_SANDBOX=docker`,
  never a requirement.
- The Python adapter must stay pure Python with zero dependencies, so the identical code runs in
  CPython and in Pyodide.
- C/C++ requires `-g -O0`; Java requires `javac -g`. Without them, locals are unreadable.
