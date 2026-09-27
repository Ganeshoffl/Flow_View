# flow_view — Design

Companion documents: [`requirements.md`](requirements.md) · [`trace-schema.md`](trace-schema.md)

## 1. Shape of the system

Five languages × four visualizations is twenty things to build if they are coupled, and nine if they
are not. Everything in this design serves that arithmetic: adapters and views communicate only
through the Universal Trace, and neither can see the other.

```
            ┌──────────── adapters (produce trace) ────────────┐
            │  Python      JavaScript     C / C++      Java     │
            │  settrace    AST instr.     gdb/MI       JDI      │
            └───────────────────────┬─────────────────────────┘
                                    │
                        Universal Trace (JSON events)
                                    │
            ┌───────────────────────┴─────────────────────────┐
            │  TraceStore — replay, inverse-step, seek, fold   │
            └───────────────────────┬─────────────────────────┘
                                    │
  ┌────────┬──────────┬─────────────┼───────────┬──────────┬─────────┐
  Code     Stack    Variables      Heap      Timeline  Narration  Metrics
```

Two properties fall out of this:

- A new language is one adapter and zero UI changes.
- A new view is one renderer and zero adapter changes.

The adapters do not share a process, a language, or even a machine with the views. The trace is the
only thing that crosses the boundary — which also means a trace saved to a file is a complete,
replayable artifact with no live dependency on anything.

## 2. Deployment profiles

One UI, two ways to execute.

### Lite — static, zero-install

```
Browser
├─ UI (React)                       ← identical to Full
├─ TraceStore                       ← identical to Full
└─ Web Worker
   ├─ Pyodide + flow_view_tracer    → Python traces
   └─ Instrumented user code        → JavaScript traces
```

No server, no network at runtime. Pyodide and all assets are vendored into the bundle, so the app
works from `file://` or any static host and is installable as a PWA. Execution happens in a Web
Worker: the main thread stays responsive, and a runaway program is terminated by killing the worker.

The worker *is* the sandbox. Browser isolation gives us no filesystem, no sockets, no escape — for
free, and more convincingly than anything we could build ourselves.

### Full — local tool, all five languages

```
localhost:7474
├─ Static UI (same bundle)
├─ FastAPI
│  ├─ POST /api/session          create
│  ├─ WS   /api/session/{id}/ws  stream events, receive stdin + control
│  └─ GET  /api/capabilities     which languages this machine can actually run
└─ Runner (subprocess, resource-limited)
   ├─ python -m flow_view.adapters.python
   ├─ node   adapters/javascript/run.js
   ├─ gdb --interpreter=mi3       (C / C++)
   └─ java -agentlib:jdwp=…       (Java)
```

Binds to `127.0.0.1` by default. Installed with `pip install flow-view`, started with `flow-view`,
which serves the UI and opens a browser.

### Why subprocess is the default and Docker is opt-in

Requiring Docker would contradict the goal of a tool anyone can install, and the threat model does
not justify it: flow_view runs code **the user already has on their own machine and could run
directly**. A sandbox here exists to stop *accidents* — infinite loops, runaway allocation, a
`while True` that fills the disk — not to defend against an attacker who already owns the machine.

So the default runner applies OS-level limits:

| Guard | Mechanism |
|---|---|
| CPU time | `RLIMIT_CPU` |
| Address space | `RLIMIT_AS` |
| File size | `RLIMIT_FSIZE` |
| Open files | `RLIMIT_NOFILE` |
| Wall clock | supervisor timer, then `SIGTERM` → `SIGKILL` |
| Working directory | fresh temp dir, removed on session end |
| Environment | scrubbed allowlist |
| Network | `unshare -n` where available; otherwise reported as unavailable in a `note` event |
| Step count | enforced inside the tracer itself |
| Process tree | new process group, whole group reaped on session end |

`FLOW_VIEW_SANDBOX=docker` switches to a container per run — no network, read-only root, dropped
capabilities, memory and pid caps — for anyone binding to a LAN address or running untrusted code.
The runner interface is identical; only the launcher changes.

Windows lacks `rlimit`; there the runner uses Job Objects for memory and CPU caps, and the
capabilities endpoint reports which guards are active. **The UI always tells the truth about which
protections are in force** rather than implying safety it does not have.

## 3. Session lifecycle

Interactive stdin is the reason this is a live session rather than a request/response. The program
must stop mid-flight and wait for a human, and what happens next depends on what they type — so the
trace cannot be pre-computed.

```
UI                          Server                        Runner
│── POST /session ─────────▶│                                │
│◀── {id, capabilities} ────│                                │
│── WS connect ────────────▶│                                │
│── {run, source, stdin} ──▶│── spawn, limits applied ──────▶│
│                           │◀── session header ─────────────│
│◀── header ────────────────│                                │
│                           │◀── event batch (~16 ms) ───────│
│◀── events ────────────────│   (collapser folds in flight)  │
│                           │◀── stdin_request ──────────────│
│◀── stdin_request ─────────│         (runner blocked)       │
│── {stdin, text} ─────────▶│── write to child stdin ───────▶│
│                           │◀── events resume ──────────────│
│◀── run_end ───────────────│◀── run_end, exit ──────────────│
```

Events are batched on a ~16 ms tick: one WebSocket frame per animation frame, which keeps a
million-event trace from drowning the socket in tiny messages.

**Playback is entirely client-side.** Stepping, back-stepping, scrubbing and speed control never
touch the server — they are operations on the TraceStore. The server's only jobs are to run the
program and to relay stdin. This is why back-stepping is instant, and why it is safe for a program
with side effects: nothing re-executes.

Sessions expire on socket close, on idle timeout, and on server shutdown. Every exit path reaps the
process group.

## 4. TraceStore

The client-side engine that turns an event stream into scrubbable state. Shared verbatim between
Lite and Full.

```
append(events)     ingest, index, fold
stateAt(step)      nearest snapshot → forward replay
next() / prev()    apply event / apply inverse
seek(step)         absolute jump
stepOver/Into/Out  frame-aware navigation
nextChange(target) jump to next mutation of a variable or object
```

`prev()` is cheap because every mutation event carries its previous value (`trace-schema.md` §1), so
inverting is mechanical. `seek()` is bounded because snapshots land every 500 steps — the worst case
is 499 replayed events, not 499,000.

State is held as flat maps (frames by id, objects by id, bindings by frame) with structural sharing
on mutation, so a React render reads current state in O(1) and re-renders only what changed.

Memory is bounded by a retention policy: full detail near the playhead, snapshots plus folded
summaries further away. Very long runs degrade into coarser history rather than exhausting the tab.

## 5. Adapters

Four adapters cover five languages — C and C++ share one, since they share a debugger and a memory model.

### Python — `sys.settrace` / `sys.monitoring`

Baseline is `sys.settrace`, which works on every supported version and inside Pyodide. On 3.12+ the
adapter prefers `sys.monitoring` for materially lower overhead.

Variables: the tracer diffs `frame.f_locals` between line events and emits `var_set` with `prev`.
Heap: an identity-keyed registry maps `id(obj)` to trace object ids, and reachable objects are
re-walked after each step, with mutations emitted as diffs. A `weakref` table plus generation counters
keep the walk proportional to *reachable* objects rather than to the whole heap.

The opaque boundary is a path test: frames whose file is not a user source file are skipped, with
`kind: library` push/pop events around them.

Interactive input replaces `builtins.input` with a function that emits `stdin_request`, blocks on the
transport, and emits `stdin_response`.

This adapter is **pure Python with no dependencies**, which is what lets the identical code run in a
CPython subprocess (Full) and inside Pyodide (Lite). One implementation, two profiles.

### JavaScript — AST instrumentation

The source is parsed, and probe calls are injected: `__fv.line(n)`, `__fv.set(name, value)`,
`__fv.branch(...)`, `__fv.push(...)`, `__fv.pop(...)`. The instrumented program is then executed
normally — in a Web Worker for Lite, in a Node subprocess for Full.

Instrumentation is chosen over the Chrome DevTools Protocol deliberately. CDP exists only in the
Full profile, so using it would mean two different JavaScript implementations with two sets of
behaviour to reconcile. Instrumentation runs identically in both, and it gives the opaque-library
boundary for free: only user code is instrumented, so library internals are invisible by construction.

Source maps tie every probe back to original lines, so what the user sees highlighted is the code
they wrote, not the rewritten form.

### C / C++ — gdb machine interface

Compiled with `-g -O0`, then driven through gdb's MI3 protocol: `-exec-step` to advance,
`-stack-list-variables` for locals, `-data-evaluate-expression` to read values,
`-data-read-memory-bytes` for raw memory.

Pointers are the reason this language pair is worth the effort. Heap allocation is tracked by
breakpoints on `malloc`/`calloc`/`realloc`/`free` and the `new`/`delete` operators, giving a live
address→allocation map. Every pointer read is checked against it, so a pointer into freed memory is
reported as `dangling: true` — the visualization can then draw the broken arrow that explains a
use-after-free, which is precisely the thing beginners cannot see in their own code.

`-O0` is non-negotiable: optimized builds elide variables, and an honest `unavailable` is the only
alternative.

### Java — JDWP / JDI

The JVM is launched with `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y` and driven over the
debug protocol: step requests for advancing, `StackFrame.getValues()` for locals,
`ObjectReference.getValues()` for fields, `ArrayReference` for arrays.

Classes are compiled with `javac -g` so local variable names survive; without it, JDWP reports only
slot numbers. Opaque boundaries come from class-name prefix filters (`java.`, `javax.`, `jdk.`, `sun.`).

### Capability detection

A missing toolchain must never break the tool. On startup the server probes for each runtime and
`/api/capabilities` reports what this machine can actually do. The UI disables unavailable languages
with the specific reason and the specific fix — *"C/C++ needs gdb; install it with `apt install gdb`"* —
rather than failing at run time with a stack trace.

## 6. Renderers

All read the same TraceStore state. None knows what language produced it.

**Code** — CodeMirror 6 in the editor. During playback the pane is *not* an editor: it is a list of
lines carrying visit counts, branch outcomes, the active line and click-to-seek, so it tokenises with
the same Lezer grammars and renders spans inside its own markup instead. Current line highlighted; executed lines
shaded by visit count; branch gutter markers showing the condition and which way it went; the source
text of the deciding expression shown inline at the branch.

**Stack** — frames newest-first, each with function, arguments and current line; recursion depth
badged; expandable locals; clicking a frame re-points the code view without moving the playhead.

**Variables** — name, value, type; changed-this-step values flagged; references rendered as chips
that highlight the corresponding heap node on hover, which is how aliasing becomes visible.

**Heap** — Canvas (not SVG; SVG stalls past a few hundred nodes). Layout is chosen per inferred shape:

| Shape | Layout |
|---|---|
| `array`, `string`, `tuple` | horizontal cell strip, indices below |
| `matrix` | grid |
| `linked_list`, `doubly_linked_list`, `circular_linked_list` | horizontal chain with arrows |
| `binary_tree`, `bst`, `nary_tree` | Reingold–Tilford tidy tree |
| `directed_graph`, `undirected_graph` | force-directed, seeded stably |
| `stack`, `queue`, `deque` | vertical / horizontal with the active end marked |
| `map`, `set` | key–value rows |
| `object`, `instance`, `struct`, `unknown` | generic record boxes with reference edges |

Node positions are animated between steps rather than recomputed from scratch, so an insertion reads
as a node *arriving* rather than the whole diagram jumping. A wrong inference is correctable from a
shape dropdown on the node, and a raw object-graph view is always one click away.

**Timeline** — call tree over wall-clock time, nesting as depth, click to seek, collapsed loop
regions shown as folded bands labelled with their iteration counts.

**Narration** — deterministic templates keyed on event type and context. `branch` events become
*"`i < 5` was false, so the loop ended"*; `var_set` becomes *"`total` changed from 6 to 10"*;
`frame_push` at depth becomes *"`fact` calls itself with n = 3 (depth 3)"*. No model, no API key, no
network — the trace already contains every fact the sentence needs, including the source text of
conditions. Templates live in one bundle per language with a shared fallback set, which also makes
translation a data change rather than a code change.

**Metrics** — running counters (comparisons, swaps, assignments, calls, allocations) and per-loop
iteration counts, with a sparkline against step number so an O(n²) shape is visible as a curve.

## 7. Repository layout

```
flow_view/
├─ packages/
│  ├─ trace-schema/         JSON Schema + generated TS types + Python dataclasses
│  ├─ trace-store/          replay, inverse-step, seek, retention
│  ├─ renderers/            the seven views
│  └─ narration/            template engine + per-language template bundles
├─ apps/
│  ├─ web/                  React + TS + Vite shell, used by both profiles
│  └─ server/               FastAPI orchestrator, runner, sandbox (Full)
├─ adapters/
│  ├─ python/               flow_view_tracer — pure Python, no deps
│  ├─ javascript/           instrumenter + runtime probes
│  ├─ native/               gdb/MI driver for C and C++
│  └─ java/                 JDI driver
├─ conformance/             shared corpus + assertions all adapters must pass
├─ examples/                curated runnable programs per language and concept
└─ docs/
```

`packages/trace-schema` is the single source of truth: TypeScript types and Python dataclasses are
both generated from the JSON Schema, so a schema change that breaks an adapter breaks the build
rather than producing a subtly wrong visualization.

## 8. Stack

React 18 + TypeScript + Vite · CodeMirror 6 · Canvas 2D for the heap · Zustand for UI state
(TraceStore is plain TypeScript, deliberately framework-free) · FastAPI + uvicorn · pytest + Vitest +
Playwright · pnpm workspaces + `uv`.

Vite produces two builds from one codebase: `web` (Full, expects a server) and `web-lite`
(self-contained, Pyodide vendored, PWA manifest).

## 9. Distribution

**Full:** `pip install flow-view`, then `flow-view`. The wheel bundles the prebuilt UI, so there is
no Node requirement for end users. `flow-view --port`, `--no-browser`, `--sandbox docker` for the
non-default cases.

**Lite:** a static directory published as a GitHub Pages site and attached to each release as a zip
for offline use. Unzip, open `index.html`, done — no install, no server, no network.

Because adapters for C/C++ and Java shell out to tools the user already has (`gcc`, `gdb`, `javac`),
flow_view never installs a toolchain itself. It detects, reports, and explains.

## 10. Risks and the response to each

| Risk | Response |
|---|---|
| Trace volume from long runs | Streaming collapse, step budget, retention policy, snapshot tuning — all specified, all tested against adversarial programs in the conformance corpus |
| `settrace` overhead | `sys.monitoring` fast path on 3.12+; budget enforced inside the tracer so a slow trace still terminates |
| **Heap re-walk cost per step — the largest unproven assumption in this design** | Phase 1 opens with a measured benchmark, not more design. If reachability-scoped walking with generation counters is not fast enough, the fallback is bounding the walk to objects within a few references of live locals — which is all any view displays anyway. Decided by measurement before the adapter is built around it. |
| Wrong structure inference | Confidence + visible evidence + user override + generic fallback; inference can be wrong but can never hide data |
| gdb absent (it is absent in the current dev sandbox) | Capability detection with an actionable message; C/C++ is the third adapter, so the tool is useful long before it lands |
| Docker unavailable (also absent in the dev sandbox) | Subprocess is the default path, Docker is opt-in — the dependency is inverted so the common case needs nothing |
| Pyodide bundle size | Lazy-loaded on first Python run, cached by service worker; JavaScript in Lite needs no download at all |
| Java local names missing | `javac -g` enforced by the adapter; if a user supplies prebuilt classes without debug info, slots are reported as `unavailable` rather than guessed |
| Optimized-out C values | `-O0` enforced; anything still unreadable is `unavailable`, never fabricated |

## 11. Deliberate non-goals

flow_view is not a debugger (no breakpoints on conditions, no mid-run state editing), not a profiler,
not an online judge, and not a code editor. It does one thing: make a running program visible.
