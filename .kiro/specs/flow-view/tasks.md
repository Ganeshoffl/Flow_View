# flow_view — Implementation Plan

Companion documents: [`requirements.md`](requirements.md) · [`design.md`](design.md) · [`trace-schema.md`](trace-schema.md)

Every phase ends at a **gate** — something demonstrable and verified. A phase is not finished because
the code exists; it is finished because the gate holds. No phase begins before the previous gate passes.

Phase order is chosen so that the riskiest assumption is tested earliest and nothing is built on an
unproven contract.

---

## Phase 0 — Contract and shell

Build the trace format and the UI *before* anything can produce a real trace, and drive the UI from
hand-written fixture traces. If the schema is wrong, this is where it is cheap to find out — after
four adapters exist, it is not.

- [x] 0.1 Monorepo scaffold: pnpm workspaces, `uv` project, TypeScript config, lint/format, CI skeleton
- [x] 0.2 `packages/trace-schema`: JSON Schema for every event in `trace-schema.md`
- [x] 0.3 Code generation: TypeScript types and Python dataclasses from the schema, with a CI check that fails if generated output is stale
- [x] 0.4 Schema validator usable from both languages
- [x] 0.5 Hand-authored fixture traces: assignment, branch, loop, function call, recursion, linked list build, tree insert, aliasing, exception, stdin
- [x] 0.6 `packages/trace-store`: append, `stateAt`, `next`/`prev`, `seek`, snapshot handling
- [x] 0.7 TraceStore property tests: forward-to-end then inverse-to-zero restores initial state exactly, for every fixture
- [x] 0.8 UI shell: layout, playback controls, keyboard bindings, fixture picker

**Gate passed.** All 17 fixtures load in a browser and step forward and backward with correct
state at every event boundary; `scripts/verify-ui.sh` drives the whole corpus and asserts each one
rewinds to a clean initial state, with zero console errors. 153 TypeScript tests and 31 Python tests
pass, including the invertibility property and forward/backward seek agreement. `pnpm schema:check`
fails the build if generated artifacts go stale.

---

## Phase 1 — Python, end to end

The first real adapter. Python first because `settrace` yields the richest data for the least work,
which makes it the fastest way to discover whether the schema survives contact with a real runtime.

- [x] 1.0 **Benchmark spike — heap walk cost.** *Done, and it overturned the design.* A full
      reachable walk costs ~28ms per step at 10k objects: 568× over budget, 284s for a 10k-step
      program. The fallback named in the design — bounding depth and object count — also failed, at
      10ms, because capping objects does nothing about fan-out inside one object. The fix needed a
      mechanism the design did not have: a per-object slot window, plus line-scoped roots and static
      mutation analysis. Now 9.6–74µs and independent of heap size. NFR-3 was wrong and has been
      corrected. See `docs/decisions/0001-reading-the-python-heap.md`.
- [ ] 1.1 `flow_view_tracer`: line stepping, frame push/pop, `var_set` with `prev` (pure Python, zero dependencies)
- [ ] 1.2 Heap registry: identity-keyed object ids, walk strategy chosen in 1.0, mutation diffing
- [ ] 1.3 Opaque library boundary by source-path test
- [ ] 1.4 Branch events: condition source text from the AST, outcome derived from observed control flow.
      **The user's condition is never re-evaluated** — that could fire side effects and change the
      program being visualized.
- [ ] 1.5 Metric events: comparisons, swaps, assignments, calls, iterations
- [ ] 1.6 Step budget, output cap, and truncation reported as a `note` plus a `run_end` status
- [ ] 1.7 Exception capture including uncaught, with the trace preserved
- [x] 1.8 **Tracing backends.** *Done, and the premise was wrong.* Both mechanisms are implemented
      behind one set of handlers, but `sys.monitoring` cannot produce identical output: `LINE` fires on
      a line *transition*, so it reports a comprehension or a one-line `for` as a single step where
      `settrace` shows every iteration. It is also only 1.07–1.16× faster. Hiding loop iterations to
      save a tenth of the time is a bad trade for this tool, and choosing per Python version would
      make traces version-dependent. **`settrace` is the default everywhere**; monitoring is explicit
      opt-in. An apparent 5× speedup turned out to be `DISABLE` permanently suppressing repeat library
      calls — 480 dropped steps. See `docs/decisions/0002-tracing-backend.md`.
- [ ] 1.9 Runner: subprocess with rlimits, temp cwd, scrubbed env, process-group reaping
- [ ] 1.10 FastAPI server: session create, WebSocket streaming, `/api/capabilities`
- [ ] 1.11 Event batching on a ~16 ms tick
- [ ] 1.12 Wire the UI to a live session; Code, Stack and Variables views driven by real traces
- [ ] 1.13 Conformance corpus + assertions, Python as the first participant

**Gate:** paste a recursive factorial, press run, watch it execute, step backward through the entire
unwind, and see correct locals in every frame. Resource limits provably stop an infinite loop and a
runaway allocation, and both leave a usable partial trace. Every emitted trace validates in CI.

---

## Phase 2 — Heap and structure inference

The visual payoff, and the hardest correctness problem in the project.

- [x] 2.1 Canvas heap renderer with animated node transitions
- [x] 2.2 Layouts: cell strip, grid, chain, tidy tree (Reingold–Tilford), force-directed, generic records
- [x] 2.3 Inference reconciliation, including adapter static hints. *Runtime inference moved
      client-side over the universal heap model, so one implementation serves every language rather
      than five — see `docs/decisions/0003-where-inference-runs.md`.*
- [x] 2.4 Runtime inference: out-degree, cycle detection, shared-path detection, uniform row lengths, ordering invariants
- [x] 2.5 Reconciliation with runtime evidence winning, plus confidence and evidence strings
- [x] 2.6 Shape override dropdown and always-available raw object-graph view
- [x] 2.7 Reference chips in the Variables view that highlight the target node, making aliasing visible
- [x] 2.8 Performance pass: 500 visible nodes at 30 fps, 10k-object programs traced without stalling

**Gate passed.** `scripts/verify-heap.sh` builds a linked list, a BST, a grid, a circular list, a
stack and a tree-shaped class wired into a cycle, runs each through the real stack, and checks what
was drawn. The cycle case reports `directed_graph` with the evidence *"the field names suggest a tree,
but the objects form a cycle"*. Every shape is overridable from the node, the evidence is always
readable, and a raw object view is one click away. 336 TypeScript tests including 26 inference, 15
layout, 8 performance and 235 cross-checks over all 33 real traces.

---

## Phase 3 — Understanding layer

The features that serve "anyone can understand it," all deterministic and offline.

- [x] 3.1 Narration template engine with per-language bundles and a shared fallback
- [x] 3.2 Templates for assignment, branch outcome, loop entry/exit, call, return, recursion depth, exception, allocation, mutation
- [x] 3.3 Control-flow presentation: executed-line shading, branch gutter, inline condition and result
- [x] 3.4 Timeline view: call tree over time, click to seek, folded loop bands
- [x] 3.5 Metrics view with counters and a step-indexed sparkline
- [x] 3.6 Step over / into / out at frame granularity; jump to next or previous change of a chosen variable or object
- [x] 3.7 Output view with stdout and stderr attributed to producing steps

**Gate passed.** `scripts/verify-narration.sh` runs a six-element bubble sort and checks the
transcript, the metrics and the timeline. It reads, in part:

> `values[j] > values[j + 1]` is true, so the body runs. · Positions 0 and 1 of `values` are swapped.
> · The loop ran 3 times and ended because its condition stopped holding.

The sparkline plots comparisons — 15 for six elements, which is 5+4+3+2+1 — clicking a timeline bar
seeks to that call, and the jump controls move the playhead to a variable's previous change. 619
TypeScript tests including 47 narration and 15 navigation.

---

## Phase 4 — Scale

Make long programs survivable, while streaming.

- [x] 4.1 Streaming loop collapser: retain first and last *K* iterations, fold the middle
- [x] 4.2 Folded spans emitted as **single composite invertible events** carrying net before/after state,
      so collapsing cannot break the invertibility guarantee the TraceStore depends on

Measured on a million-iteration accumulate loop: 730 events, 577 steps, 0.2 MB, 18 MB peak RSS, and
the exact sum. Two constraints turned out to matter more than the folding itself:

- **A fold may only swallow what it can represent.** `CollapseEffect` covers variable and heap writes,
  so a span containing output, a blocking read, an exception, a new object or an unbalanced frame is
  not folded at all. Compression that loses a `print` would make the trace a lie, and the step and
  output budgets already bound those cases.
- **Folding discards steps, not work.** Metric deltas are summed onto the collapse event, so a folded
  trace still reports a million iterations. A metrics pane that got cheaper because the trace got
  shorter would misrepresent the algorithm — which is the one thing the metrics pane exists to show.

`collapse` gained `from_iter`/`to_iter` for 4.3: a re-run has its own seq numbers, so a span can only
be re-requested by iteration range.
- [ ] 4.3 Expand-on-demand by re-running a single region with folding disabled
- [ ] 4.4 TraceStore retention policy: detail near the playhead, summaries far from it
- [ ] 4.5 Delta-encoded snapshots with periodic full keyframes; interval adapted to heap size, tuned
      against trace bytes versus seek latency
- [ ] 4.6 Adversarial corpus: million-iteration loops, deep recursion, wide heaps, huge strings
      — the million-iteration loop is covered (conformance case 016 and a server-level check); deep
      recursion, wide heaps and huge strings are not

**Gate:** a one-million-iteration loop traces to completion, stays responsive, reports accurate final
state, and never exhausts browser memory. Seek latency stays inside the 50 ms budget at 100k retained steps.

---

## Phase 5 — Interactive input

Mostly landed early, and not because it was brought forward. The blocking protocol was already
written; what stopped it working was three buffers in a row, each of which looked like a performance
detail rather than a correctness one:

- the tracer never flushed, so Python's 8 KB pipe buffer held the question;
- the server decided whether to flush a batch only when the *next* event arrived, which for a blocked
  program is never;
- prefilled stdin was written without the trailing newline that `input()` needs to return.

Any one of them deadlocks the run with the UI showing "running". Fixing them also exposed that every
wall-clock deadline in the stack was timing the *person*: a run was killed for "timeout" when
somebody had spent thirty seconds reading the question.

- [x] 5.1 `stdin_request` blocking protocol through runner, server and UI
- [x] 5.2 Input prompt UI, appearing where execution paused — no history yet
- [x] 5.3 Prefilled-stdin mode producing a fully scrubbable trace with no human in the loop
- [x] 5.4 Deterministic replay from recorded `stdin_response` events
- [x] 5.6 Time spent waiting for a person excluded from the program's execution budget and clock
- [ ] 5.5 Back-stepping across an input boundary, then forward again, without re-prompting
- [ ] 5.7 Prompt history, so a re-run can be answered the same way without retyping

**Gate:** a program that asks three questions runs interactively, then replays start to finish from the
saved trace with no prompting and byte-identical results.

Currently proven for one question (`scripts/verify-live.sh`, plus
`TestAProgramThatStopsToAskAQuestion`). The three-question case and back-stepping across an input
boundary are what remain.

---

## Phase 6 — Lite profile

- [ ] 6.1 Web Worker execution host with terminate-on-runaway
- [ ] 6.2 Pyodide integration running the *unmodified* Phase 1 tracer
- [ ] 6.3 `input()` bridged to the UI prompt inside the worker
- [ ] 6.4 Vendored assets, lazy Pyodide load, service worker caching
- [ ] 6.5 PWA manifest, offline verification with the network disabled
- [ ] 6.6 `web-lite` build target and static release artifact

**Gate:** open the Lite build from `file://` with networking off, run a Python program with input, and
get a trace identical to the one the Full profile produces for the same source.

---

## Phase 7 — JavaScript

Second language, and the real test of whether the adapter abstraction holds. Zero UI changes are
permitted in this phase — if any are needed, the abstraction leaked and that is the bug.

- [ ] 7.1 AST instrumenter: line, assignment, branch, call, return probes
- [ ] 7.2 Runtime probe library emitting trace events
- [ ] 7.3 Source maps so highlighting lands on original lines
- [ ] 7.4 Heap tracking for objects, arrays, maps, sets, closures
- [ ] 7.5 Node subprocess runner (Full) and Web Worker runner (Lite) from one instrumenter
- [ ] 7.6 Closure and scope-chain representation
- [ ] 7.7 JavaScript joins the conformance corpus; cross-language agreement asserted

**Gate:** the same algorithm in Python and JavaScript produces structurally equivalent traces and
renders identically. No renderer was modified to make it work.

---

## Phase 8 — C and C++

- [ ] 8.1 gdb/MI3 driver: spawn, step, read locals, evaluate expressions, read memory
- [ ] 8.2 Compile pipeline with `-g -O0`, diagnostics mapped to editor lines
- [ ] 8.3 Allocation tracking via breakpoints on `malloc`/`calloc`/`realloc`/`free`/`new`/`delete`
- [ ] 8.4 Pointer model: address→allocation map, validity checks, dangling detection
- [ ] 8.5 Stack frame and struct layout representation
- [ ] 8.6 Memory view: addresses, regions, pointer arrows, broken arrows for dangling pointers
- [ ] 8.7 `unavailable` handling wherever gdb cannot read a value, never fabricated
- [ ] 8.8 Capability detection for `gcc`/`g++`/`gdb` with actionable install guidance
- [ ] 8.9 C and C++ join the conformance corpus

**Gate:** a linked list in C renders with real addresses; a use-after-free visibly shows a pointer into
freed memory. With gdb absent, the tool still starts, C/C++ is cleanly disabled with an explanation,
and every other language keeps working.

---

## Phase 9 — Java

- [ ] 9.1 JDI driver: launch with JDWP, step requests, frame and object reads
- [ ] 9.2 `javac -g` compile pipeline with diagnostics mapped to editor lines
- [ ] 9.3 Objects, arrays, collections, `static` and instance fields
- [ ] 9.4 Class-prefix opaque filtering
- [ ] 9.5 Capability detection for the JDK
- [ ] 9.6 Java joins the conformance corpus

**Gate:** a Java BST insert renders and steps correctly. All five languages pass the full conformance
suite, and the same algorithm looks recognizably the same in all of them.

---

## Phase 10 — Ship

- [ ] 10.1 `flow-view` CLI: serve, open browser, `--port`, `--no-browser`, `--sandbox`
- [ ] 10.2 Wheel bundling the prebuilt UI so end users need no Node
- [ ] 10.3 Windows runner using Job Objects; honest capability reporting per platform
- [ ] 10.4 Optional Docker sandbox mode behind the same runner interface
- [ ] 10.5 Example library across languages and concepts
- [ ] 10.6 Session save/load and trace export/import
- [ ] 10.7 Accessibility pass: full keyboard playback, screen-reader navigation of narration and variables
- [ ] 10.8 Docs: install, first run, one page per language, trace format reference, adapter authoring guide
- [ ] 10.9 Release automation: wheel, Lite zip, Pages deploy
- [ ] 10.10 Cross-platform verification on Linux, macOS and Windows

**Gate:** a clean machine runs `pip install flow-view && flow-view` and visualizes a program in every
language its toolchain supports. The Lite zip works offline with no install.

---

## Deferred

Kept out of v1 on purpose, and unblocked by this architecture rather than obstructed by it. Each is
additive: new event types and new renderers, no changes to what already works.

- Concurrency — threads, async/await, promises; timeline lanes and an event-loop view
- Rendered graphical output — matplotlib, turtle, canvas
- Multi-file projects
- Step-into for pure Python and JavaScript library code
- More languages — Go, Rust, C#, Ruby
- Shareable permalinks and embeds, GIF/video export
- Optional local LLM narration, off by default, never required

---

## Standing rules

1. **The gate is the definition of done.** Code that exists but cannot be demonstrated is not finished.
2. **The schema is the contract.** An adapter that needs a renderer change, or a renderer that needs an
   adapter change, is a design bug to fix rather than a diff to merge.
3. **No network at runtime, ever.** No API keys, no external calls, no exceptions.
4. **Honesty over polish.** Unreadable values say `unavailable`. Inactive sandbox guards are reported.
   Low-confidence inference says so. A truncated trace says where it stopped.
5. **A missing toolchain disables one language, never the tool.**
