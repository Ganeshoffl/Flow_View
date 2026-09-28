# flow_view

**See what your code does while it runs.**

Paste a program, press run, and watch execution happen: the line currently executing, the call stack,
every variable as it changes, the objects on the heap and how they point at each other, and a
plain-English account of each step. Step forward, step *backward*, or play it like a video.

Supports **Python, JavaScript, C, C++ and Java**.

> **Status: specification complete, implementation starting.**
> The design is finished and reviewable — see [the spec](.kiro/specs/flow-view/). Code lands phase by
> phase from [the implementation plan](.kiro/specs/flow-view/tasks.md).

---

## Why it exists

Most people learn what code *means* by reading it, and then have to guess what it *does*. A pointer
into freed memory, a loop that ends one iteration early, two variables that turn out to be the same
object — these are invisible in source text and obvious the moment you can see them.

flow_view makes them visible.

## Principles

- **Runs on your machine.** A local tool, not a service. Binds to localhost.
- **Works offline.** Fully functional with the network off, including air-gapped.
- **No API keys, no external calls, no LLM.** The narration is generated from the execution trace
  itself, deterministically. Nothing to sign up for, nothing to pay for.
- **Honest.** If a value cannot be read, it says so. If a guess about a data structure is uncertain,
  it says so, shows its evidence, and lets you correct it.

## Install and run it today

```sh
pip install 'flow-view[server]'
flow-view
```

That serves the interface and the API from `127.0.0.1:7474` and opens a browser. No network is
used after installation, and nothing is sent anywhere.

The `[server]` extra is not optional in practice — it carries FastAPI, uvicorn and a WebSocket
implementation, and every run streams over a WebSocket. The core package stays dependency-free so the
tracer can run unchanged inside Pyodide when the Lite profile lands.

**Do not bind it to a public interface.** flow_view runs the code you paste. `--host` exists for
running it on a machine you reach over a trusted network, and the guards it applies (no sockets, writes
confined to the run directory, no subprocesses, rlimits) are there to catch accidents, not to contain
someone attacking you. Exposed publicly it is remote code execution with a friendly interface.

### What actually works right now

| | |
|---|---|
| Python | traced, stepped, explained |
| JavaScript, C, C++, Java | not yet — the adapters are unwritten |
| Lite profile (no install, in-browser) | not yet — needs Pyodide in a worker |

The table below is the plan, not the present.

## Two ways to run it, eventually

|  | **Lite** | **Full** |
|---|---|---|
| Install | none — open it in a browser | `pip install 'flow-view[server]'` |
| Languages | Python, JavaScript | Python, JavaScript, C, C++, Java |
| Backend | none | local server on `127.0.0.1` |
| Offline | yes (PWA) | yes |
| For | learning, quick checks | everything, classrooms, real memory semantics |

Same interface, same visualizations. Only the execution engine differs.

C, C++ and Java need real debuggers (`gdb`, JDWP), so they require the Full profile.

## What you see

| View | Shows |
|---|---|
| **Code** | current line, lines already executed, which way each branch went and why |
| **Stack** | every frame with arguments and locals; recursion depth |
| **Variables** | current values, types, and what just changed |
| **Heap** | objects and references, drawn as what they actually are — arrays as cells, linked lists as chains, trees as trees, graphs as graphs |
| **Timeline** | the call tree over time; click to jump anywhere |
| **Narration** | *"`i < 5` was false, so the loop ended"* — one sentence per step |
| **Metrics** | comparisons, swaps, allocations, iterations; an O(n²) curve looks like one |

Data structures are **recognized automatically** from your code and from the live object graph — write
a class with a `next` field and it draws a linked list, without being told. When the guess is wrong,
you can override it, and a raw object view is always one click away.

## How it works

One idea carries the whole design: every language produces the same **Universal Trace** — a
language-agnostic stream of events describing what happened. Adapters produce it; visualizations
consume it. Neither knows the other exists.

```
Python · JavaScript · C/C++ · Java
                │
      Universal Trace (events)
                │
   Code · Stack · Variables · Heap · Timeline · Narration · Metrics
```

So a new language is one adapter and zero UI changes, and a new visualization is one renderer and zero
adapter changes.

Because every state change in the trace records what it overwrote, **stepping backward replays
recorded history rather than re-running your program** — which is what makes it instant, and safe for
programs with side effects.

## Documentation

- [Requirements](.kiro/specs/flow-view/requirements.md) — what it does and what it deliberately does not
- [Design](.kiro/specs/flow-view/design.md) — architecture, adapters, sandboxing, renderers
- [Trace schema](.kiro/specs/flow-view/trace-schema.md) — the contract everything depends on
- [Implementation plan](.kiro/specs/flow-view/tasks.md) — phases, each with a verification gate

## Not what it is

Not a debugger (no breakpoints, no editing state mid-run), not a profiler, not an online judge, not a
code editor. It does one thing: make a running program visible.

## License

MIT
