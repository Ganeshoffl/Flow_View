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

- [ ] 0.1 Monorepo scaffold: pnpm workspaces, `uv` project, TypeScript config, lint/format, CI skeleton
- [ ] 0.2 `packages/trace-schema`: JSON Schema for every event in `trace-schema.md`
- [ ] 0.3 Code generation: TypeScript types and Python dataclasses from the schema, with a CI check that fails if generated output is stale
- [ ] 0.4 Schema validator usable from both languages
- [ ] 0.5 Hand-authored fixture traces: assignment, branch, loop, function call, recursion, linked list build, tree insert, aliasing, exception, stdin
- [ ] 0.6 `packages/trace-store`: append, `stateAt`, `next`/`prev`, `seek`, snapshot handling
- [ ] 0.7 TraceStore property tests: forward-to-end then inverse-to-zero restores initial state exactly, for every fixture
- [ ] 0.8 UI shell: layout, playback controls, keyboard bindings, fixture picker

**Gate:** load every fixture in the browser and step forward and backward through all of them with
correct state at each step. Invertibility tests pass. Generated types match the schema in CI.

---

## Phase 1 — Python, end to end

The first real adapter. Python first because `settrace` yields the richest data for the least work,
which makes it the fastest way to discover whether the schema survives contact with a real runtime.

- [ ] 1.1 `flow_view_tracer`: line stepping, frame push/pop, `var_set` with `prev` (pure Python, zero dependencies)
- [ ] 1.2 Heap registry: identity-keyed object ids, reachability-scoped walk, mutation diffing
- [ ] 1.3 Opaque library boundary by source-path test
- [ ] 1.4 Branch events with condition source text and evaluated result
- [ ] 1.5 Metric events: comparisons, swaps, assignments, calls, iterations
- [ ] 1.6 Step budget, output cap, and truncation reported as a `note` plus a `run_end` status
- [ ] 1.7 Exception capture including uncaught, with the trace preserved
- [ ] 1.8 `sys.monitoring` fast path on 3.12+, `settrace` fallback below it, identical output from both
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

- [ ] 2.1 Canvas heap renderer with animated node transitions
- [ ] 2.2 Layouts: cell strip, grid, chain, tidy tree (Reingold–Tilford), force-directed, generic records
- [ ] 2.3 Static inference from class and type declarations
- [ ] 2.4 Runtime inference: out-degree, cycle detection, shared-path detection, uniform row lengths, ordering invariants
- [ ] 2.5 Reconciliation with runtime evidence winning, plus confidence and evidence strings
- [ ] 2.6 Shape override dropdown and always-available raw object-graph view
- [ ] 2.7 Reference chips in the Variables view that highlight the target node, making aliasing visible
- [ ] 2.8 Performance pass: 500 visible nodes at 30 fps, 10k-object programs traced without stalling

**Gate:** build a linked list, a BST, a 2-D grid and a cyclic graph in Python and watch each render in
its correct form and animate correctly as it mutates. A tree-shaped class holding a cycle is reported
as a graph, with the evidence shown. Every wrong inference is correctable and nothing is ever hidden.

---

## Phase 3 — Understanding layer

The features that serve "anyone can understand it," all deterministic and offline.

- [ ] 3.1 Narration template engine with per-language bundles and a shared fallback
- [ ] 3.2 Templates for assignment, branch outcome, loop entry/exit, call, return, recursion depth, exception, allocation, mutation
- [ ] 3.3 Control-flow presentation: executed-line shading, branch gutter, inline condition and result
- [ ] 3.4 Timeline view: call tree over time, click to seek, folded loop bands
- [ ] 3.5 Metrics view with counters and a step-indexed sparkline
- [ ] 3.6 Step over / into / out at frame granularity; jump to next or previous change of a chosen variable or object
- [ ] 3.7 Output view with stdout and stderr attributed to producing steps

**Gate:** a bubble sort narrates itself line by line in correct plain English, the metrics view shows a
recognizably quadratic comparison curve, and the timeline correctly seeks to any call.

---

## Phase 4 — Scale

Make long programs survivable, while streaming.

- [ ] 4.1 Streaming loop collapser: retain first and last *K* iterations, fold the middle
- [ ] 4.2 Net-effect preservation across folded spans, so state stays exact even where detail is dropped
- [ ] 4.3 Expand-on-demand by re-running a single region with folding disabled
- [ ] 4.4 TraceStore retention policy: detail near the playhead, summaries far from it
- [ ] 4.5 Snapshot interval tuning measured against trace size and seek latency
- [ ] 4.6 Adversarial corpus: million-iteration loops, deep recursion, wide heaps, huge strings

**Gate:** a one-million-iteration loop traces to completion, stays responsive, reports accurate final
state, and never exhausts browser memory. Seek latency stays inside the 50 ms budget at 100k retained steps.

---

## Phase 5 — Interactive input

- [ ] 5.1 `stdin_request` blocking protocol through runner, server and UI
- [ ] 5.2 Input prompt UI with history, appearing exactly where execution paused
- [ ] 5.3 Prefilled-stdin mode producing a fully scrubbable trace with no human in the loop
- [ ] 5.4 Deterministic replay from recorded `stdin_response` events
- [ ] 5.5 Back-stepping across an input boundary, then forward again, without re-prompting

**Gate:** a program that asks three questions runs interactively, then replays start to finish from the
saved trace with no prompting and byte-identical results.

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
