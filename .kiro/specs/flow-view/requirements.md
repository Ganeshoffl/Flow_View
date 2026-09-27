# flow_view — Requirements

## 1. Product statement

flow_view is an installable tool that shows what code *does* while it runs. You paste a program,
press run, and watch execution unfold: the current line, the call stack, every variable, the objects
on the heap and how they point at each other, and a plain-English account of each step.

It is a **local tool**, not a hosted service. It installs on any machine, binds to localhost, runs
fully offline, and never calls an external API.

## 2. Audience

Two groups, served by two deployment profiles (§4):

- **Learners** — students, self-taught programmers, anyone who wants to *see* why a loop terminates
  or how a recursive call unwinds. They need zero-install and instant feedback.
- **Practitioners** — developers, teachers, lab instructors. They need more languages, real memory
  semantics, and the ability to run it in a classroom or on an air-gapped machine.

## 3. Scope decisions (locked)

| Decision | Choice |
|---|---|
| Languages at launch | Python, JavaScript, C, C++, Java |
| Visualization modes | All four: control flow, call stack + variables, heap/memory graph, execution timeline |
| Playback | Step forward, step backward, and continuous play with speed control |
| Programs accepted | Single file, real-ish (may import libraries) |
| Library calls | Opaque by default — arguments in, result out, one step |
| Standard input | Interactive by default; optional prefilled-stdin mode |
| Data structure recognition | Automatically inferred, with user override |
| Narration | Deterministic templates generated from the trace |
| LLM / external APIs | **None.** Zero API keys, zero network calls at runtime |
| Offline | Must work fully offline, including air-gapped |
| Screen target | Desktop-first; tablet responsive; phone read-only degraded |
| Mid-run state editing | Not supported — replay is read-only |
| Persistence | Minimal local save of source + session; no accounts |
| Concurrency visualization | Deferred (post-launch) |
| Graphical program output (matplotlib, turtle) | Deferred (post-launch) |
| Multi-file projects | Deferred (post-launch) |
| Public internet-facing instance | Out of scope — localhost/LAN only |

## 4. Deployment profiles

Both profiles share one UI, one set of renderers, and one trace format. Only the execution engine differs.

### Lite
- Static web app. No install, no server, no Docker. Opens from a file or any static host.
- Installable as a PWA; all assets vendored so it works offline after first load.
- Languages: **Python** (via Pyodide) and **JavaScript** (instrumented in-browser).
- Purpose: the zero-friction path for learners.

### Full
- Installed as a package, launched with a single command, opens a browser at localhost.
- Languages: **all five.**
- Execution runs as a resource-limited local subprocess by default; Docker sandboxing is an
  opt-in hardening mode, not a requirement.
- Purpose: complete capability, classroom and offline use.

**Accepted limitation:** C, C++ and Java require the Full profile. The Lite profile cannot run them.

## 5. Functional requirements

### 5.1 Source input
- **FR-1** Accept pasted or typed source in an editor with syntax highlighting for all five languages.
- **FR-2** Detect language from a user selection; offer a best-guess default from the source text.
- **FR-3** Report syntax and compile errors inline, positioned on the offending line, before any run.
- **FR-4** Ship a browsable library of runnable examples per language and per concept
  (recursion, sorting, linked lists, trees, pointers, closures).

### 5.2 Execution and trace capture
- **FR-5** Execute the program and emit a **Universal Trace** (see `trace-schema.md`) —
  a language-agnostic event stream. Every adapter produces this; every view consumes it.
- **FR-6** Stream trace events to the UI as they are produced, so long programs show progress
  immediately rather than after completion.
- **FR-7** Pause execution when the program reads stdin, prompt the user, and resume on submission.
- **FR-8** Record stdin responses in the trace so a replay is byte-for-byte deterministic.
- **FR-9** Attribute every step to a source line and a stack frame.
- **FR-10** Treat calls into library or runtime code as single opaque steps, capturing arguments and
  return value. Offer step-into only where readable source exists (pure Python, pure JavaScript).
- **FR-11** Enforce a step budget, a wall-clock timeout, a memory cap and an output cap. On breach,
  stop cleanly and present the partial trace as a usable result, not an error.
- **FR-12** Capture uncaught exceptions with type, message, and the frame where they were raised,
  and present them as the final trace state rather than discarding the run.

### 5.3 Playback
- **FR-13** Step forward and backward one step at a time over any portion of the trace already captured.
- **FR-14** Play continuously with adjustable speed, plus pause.
- **FR-15** Scrub to an arbitrary point via a timeline control.
- **FR-16** Step over, step into and step out at frame granularity, not just line granularity.
- **FR-17** Jump to the next or previous change of a chosen variable or heap object.
- **FR-18** Backward stepping must not re-execute the program. It reconstructs prior state from the
  recorded trace.

### 5.4 Views
- **FR-19 Code view** — highlight the executing line; mark lines already executed; show, per branch,
  which way it went and why (the condition and its evaluated result).
- **FR-20 Stack view** — every frame with function name, arguments, and current line; expandable locals.
- **FR-21 Variables view** — names, current values, and types, with changed values visibly flagged
  at the step where they change.
- **FR-22 Heap view** — objects as nodes and references as edges, laid out according to the inferred
  structure: arrays as cell strips, linked lists as chains, trees as tidy trees, graphs force-directed,
  everything else as a generic object graph.
- **FR-23 Timeline view** — the call tree over time, showing nesting and duration, clickable to seek.
- **FR-24 Output view** — stdout and stderr interleaved in order, tied to the step that produced them.
- **FR-25 Narration view** — a plain-English sentence per step, generated from trace events by template.
- **FR-26 Metrics view** — counters for comparisons, swaps, assignments, loop iterations and function
  calls, with per-loop iteration counts.

### 5.5 Structure inference
- **FR-27** Infer data structure shape from static analysis of type and class definitions combined
  with runtime inspection of the actual object graph. Runtime evidence overrides static guesses.
- **FR-28** Recognize at minimum: array/list, matrix/2-D grid, string, tuple, set, map/dict,
  singly linked list, doubly linked list, circular linked list, binary tree, binary search tree,
  n-ary tree, directed graph, undirected graph, stack, queue, and plain object/struct.
- **FR-29** Attach a confidence level to every inference and expose the evidence behind it.
- **FR-30** Let the user override an inferred shape, and always offer a raw "just show the objects" view.
- **FR-31** Never let a wrong inference hide data. An unrecognized structure falls back to the generic
  object graph rather than rendering nothing.

### 5.6 Large traces
- **FR-32** Collapse repeated loop iterations: keep the first and last few iterations in full detail,
  fold the middle into a summary that reports iteration count and aggregate metric deltas.
- **FR-33** Collapsing must work on a *streaming* trace, before the program has finished.
- **FR-34** Allow expanding a collapsed region on demand, subject to the retained-detail limit.

### 5.7 Persistence
- **FR-35** Save and reload a session locally: source, language, stdin, and view configuration.
- **FR-36** Export a captured trace to a file and import it back, so a trace can be inspected
  without re-running, and shared by copying a file.

## 6. Non-functional requirements

### Performance
- **NFR-1** Step and back-step in the UI respond in under 50 ms at the 95th percentile for traces up to
  100,000 retained steps.

  Measured at 100,000 steps: stepping either way is ~0.002 ms, and a 1000-step seek is under 0.6 ms,
  so stepping as stated is met with four orders of magnitude to spare. A *full-length* jump — clicking
  the far end of the playback bar — is not: 43 ms on a minimal trace and 111 ms at four events per
  step. That is task 4.5's job, and the gap is pinned by a test rather than left to be discovered.
- **NFR-2** First trace events reach the UI within 500 ms of pressing run for a trivial program.
- **NFR-3** Per-step tracing cost stays within 100µs, and must not grow with the size of the
  program's heap.

  *Revised in Phase 1 after measurement.* This originally asked for overhead within roughly 100×
  native speed, which no pure-Python tracer can deliver — `sys.settrace` alone exceeds it before any
  state is inspected, so the figure was aspiration rather than analysis. A per-step budget is both
  achievable and closer to what a user actually experiences. Measured worst case is 74µs, with
  typical data shapes at 10–40µs. See `docs/decisions/0001-reading-the-python-heap.md`.
- **NFR-4** Heap view sustains 30 fps while animating up to 500 visible nodes.

### Resource safety
- **NFR-5** Every run is bounded: CPU time, wall clock, address space, file size, and step count.
- **NFR-6** Child processes get a scrubbed environment, a temporary working directory, and no network.
- **NFR-7** No run may outlive its session. Orphaned processes are reaped.

### Portability and distribution
- **NFR-8** Full profile installs from a single package and runs with one command on Linux, macOS and Windows.
- **NFR-9** Adapters degrade gracefully: a missing toolchain (no gdb, no JDK) disables that language
  with a clear explanation and leaves the rest working.
- **NFR-10** Lite profile has no build step for the end user and no runtime network dependency.

### Determinism and correctness
- **NFR-11** The same source plus the same stdin produces the same trace.
- **NFR-12** Every emitted trace validates against the published schema in CI.
- **NFR-13** Each adapter is verified against a shared conformance suite, so all five languages
  agree on what a given construct should look like.

### Maintainability
- **NFR-14** The trace schema is the sole contract between adapters and UI. Neither side may
  depend on the other's internals.
- **NFR-15** Adding a language means writing one adapter and changing nothing in the UI.
- **NFR-16** Adding a view means writing one renderer and changing no adapter.

### Accessibility
- **NFR-17** Full keyboard control of playback.
- **NFR-18** Structure and state are conveyed by text, not colour alone; the narration and variables
  views are screen-reader navigable.

## 7. Out of scope for v1

Threads, async/await and event-loop visualization · rendered graphical output · multi-file and
multi-module projects · package installation on the user's behalf · editing state mid-run ·
accounts, cloud sync, public sharing · a hosted public instance · languages beyond the five listed.
