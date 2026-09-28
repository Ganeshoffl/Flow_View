# Universal Trace Schema

The single contract in flow_view. Adapters (Python, JavaScript, C/C++, Java) **produce** it.
Views (code, stack, heap, timeline, narration, metrics) **consume** it. Neither side knows the other exists.

This document is normative. The machine-readable JSON Schema lives in `packages/trace-schema/`,
generated types are derived from it, and CI validates every adapter's output against it.

## 1. Model

A trace is an ordered stream of **events**. Each event is a small, self-contained fact about
execution. Replaying events from the start in order reconstructs complete program state at any point.

Three ideas make this work:

1. **Mutations carry their previous value.** Every event that changes state records what the state
   *was*. This makes every event invertible, so backward stepping is applying inverses — no
   re-execution, no full snapshots per step.
2. **Snapshots punctuate the stream.** A complete state snapshot every *N* steps (default 500) bounds
   how far the client ever has to replay to reach an arbitrary seek target.
3. **Values are either primitives or heap references — never nested objects.** A variable holds
   `{"prim": 42}` or `{"ref": 17}`. Object contents live in the heap model and are mutated by their
   own events. Without this rule, aliasing and cycles cannot be represented, and mutation of a shared
   object would have to be duplicated everywhere it appears.

## 2. Envelope

```json
{
  "schema": "flow_view/trace@1",
  "session": {
    "id": "0f2c…",
    "language": "python",
    "language_version": "3.12.4",
    "adapter_version": "1.0.0",
    "profile": "full",
    "source_files": [{ "path": "main.py", "sha256": "…", "line_count": 24 }],
    "entry": { "path": "main.py", "line": 1 },
    "limits": { "max_steps": 200000, "wall_ms": 30000, "memory_mb": 512, "output_bytes": 1048576 },
    "started_at": "2026-09-26T16:42:00Z"
  },
  "events": [ /* … */ ]
}
```

Streaming sends the `session` object first, then events in batches. A saved trace file is the same
structure with `events` fully materialized.

## 3. Common event fields

| Field | Type | Meaning |
|---|---|---|
| `seq` | int | Monotonic from 0. The identity of a point in time. |
| `t` | string | Event type (§4). |
| `step` | int? | Step ordinal. Present on events the user can land on; absent on bookkeeping events. |
| `frame` | int? | Owning frame id. |
| `line` | int? | 1-based source line. |
| `path` | string? | Source file. Omitted when it is the entry file. |
| `ms` | number? | Milliseconds since run start. Wall-clock, for the timeline view. |

Only `seq` and `t` are universally required.

## 4. Event types

### 4.1 Lifecycle

| Type | Payload | Notes |
|---|---|---|
| `run_start` | — | First event. |
| `run_end` | `status`: `ok` \| `error` \| `timeout` \| `step_limit` \| `memory_limit` \| `killed`, `exit_code`, `steps`, `duration_ms` | Always emitted, including on limit breach. A truncated trace is a valid trace. |

### 4.2 Stepping and control flow

| Type | Payload | Notes |
|---|---|---|
| `step_line` | — | Execution arrived at `line` in `frame`. The atom of playback. |
| `branch` | `kind`: `if` \| `elif` \| `else` \| `while` \| `for` \| `switch` \| `ternary` \| `guard`, `expr`: string, `outcome`: `taken` \| `not_taken`, `target_line`: int?, `result`: bool \| string \| null | Why control went where it did. Drives both the flow view and narration. `expr` is the source text of the condition, obtained from the AST. |

**`branch.outcome` is derived from observed control flow — never by evaluating the condition.**
An adapter determines the outcome by seeing where execution actually went (into the body, or past it),
because re-evaluating a user expression to learn its value could trigger side effects and change the
behaviour of the program being visualized. `if queue.pop():` must never be evaluated twice.

`result` is populated only where the runtime surfaces the value for free — AST-instrumented
JavaScript can capture it, `settrace`-based Python cannot. It is `null` otherwise, and no view may
depend on it. `outcome` is always present, and is sufficient for both narration and the flow view.
| `loop_enter` | `region`: int, `line_start`, `line_end` | Opens a loop region. |
| `loop_iter` | `region`: int, `i`: int | One iteration boundary. Basis for collapsing (§7). |
| `loop_exit` | `region`: int, `iterations`: int, `reason`: `condition` \| `break` \| `return` \| `exception` | Why the loop ended. |
| `jump` | `kind`: `break` \| `continue` \| `goto`, `target_line` | Non-linear control transfer. |

### 4.3 Frames

| Type | Payload | Notes |
|---|---|---|
| `frame_push` | `frame`: int, `func`: string, `args`: [{`name`, `value`}], `caller`: int?, `kind`: `user` \| `library` \| `builtin` \| `method` \| `constructor`, `recursion_depth`: int | `kind: library` marks an opaque call (§6). |
| `frame_pop` | `frame`: int, `return_value`: Value?, `reason`: `return` \| `implicit` \| `exception` | |

Frame ids are unique for the whole run — never reused — so the timeline can reference a specific
invocation, and recursion produces distinct frames per depth.

### 4.4 Variables

| Type | Payload | Notes |
|---|---|---|
| `var_set` | `name`, `value`: Value, `prev`: Value?, `scope`: `local` \| `param` \| `global` \| `closure` \| `static` \| `field`, `declared`: bool | `prev` absent means the name did not exist. `declared: true` on first binding. |
| `var_del` | `name`, `prev`: Value | Scope exit, `del`, block end. |

### 4.5 Heap

| Type | Payload | Notes |
|---|---|---|
| `obj_new` | `obj`: int, `kind`: ObjKind, `type_name`: string, `size`: int?, `addr`: string?, `summary`: string? | `addr` is the real address for C/C++; absent for managed languages. |
| `obj_set` | `obj`: int, `key`: int \| string, `value`: Value, `prev`: Value?, `op`: `set` \| `insert` \| `append` \| `delete` | `key` is an index for sequences, a field or map key otherwise. `op` distinguishes replacing element 3 from inserting at 3 — the difference matters for animation. |
| `obj_resize` | `obj`: int, `length`: int, `prev_length`: int | Bulk length change (`clear()`, `extend`, array realloc). |
| `obj_free` | `obj`: int | C/C++ `free`/`delete` only. Managed languages do not report collection. |

`ObjKind` (renderer hint, not a claim about semantics):
`list` · `array` · `tuple` · `string` · `bytes` · `set` · `map` · `object` · `instance` · `struct` ·
`function` · `closure` · `class` · `module` · `iterator` · `generator` · `exception` · `pointer` · `opaque`

### 4.6 Native memory (C/C++ only)

| Type | Payload | Notes |
|---|---|---|
| `mem_alloc` | `addr`, `size`, `region`: `heap` \| `stack`, `via`: `malloc` \| `calloc` \| `realloc` \| `new` \| `new[]` \| `alloca` | |
| `mem_free` | `addr`, `via`: `free` \| `delete` \| `delete[]` \| `scope_exit` | |
| `ptr_set` | `obj`? / `name`?, `to_addr`, `prev_addr`?, `valid`: bool, `dangling`: bool | Pointer retargeting. `dangling: true` when the target was freed — the single most valuable teaching signal in C. |

### 4.7 I/O

| Type | Payload | Notes |
|---|---|---|
| `stdout` / `stderr` | `text` | Attributed to the current step, so output lines up with the line that printed it. |
| `stdin_request` | `prompt`: string? | Execution is now blocked awaiting input. Adapters must flush before blocking: a question left in a buffer cannot be answered, so the run deadlocks. |
| `stdin_response` | `text`, `source`: `interactive` \| `prefilled`, `waited_ms`: number? | Recorded so replay is deterministic without a human. `source` is derived from `waited_ms` by the adapter, and corrected by the host that supplied the input where it knows exactly. Time in `waited_ms` is excluded from the program's `ms` clock and from its wall-clock budget — it is the person's time, not the program's. |

### 4.8 Errors

| Type | Payload | Notes |
|---|---|---|
| `exception_raise` | `type`, `message`, `frame`, `obj`? | |
| `exception_catch` | `frame`, `handler_line` | |
| `exception_uncaught` | `type`, `message`, `stack`: [{`func`, `path`, `line`}] | Terminal, but the trace stays replayable. |

### 4.9 Analysis

| Type | Payload | Notes |
|---|---|---|
| `metric` | `name`: `comparison` \| `swap` \| `assignment` \| `call` \| `iteration` \| `allocation` \| `read` \| `write`, `delta`: int, `region`: int? | Counters for the metrics view. Emitted by the adapter where it can identify the operation cheaply. |
| `structure_hint` | `obj`: int, `shape`: Shape, `confidence`: `high` \| `medium` \| `low`, `evidence`: string[], `root`: bool | Inference output (§5). Advisory — the client may override. |
| `snapshot` | `state`: StateSnapshot | Periodic full state for fast seeking (§8). |
| `collapse` | `region`: int, `from_seq`, `to_seq`, `iterations`, `metrics`: {name: int} | Marks a folded span (§7). |
| `note` | `level`: `info` \| `warn`, `text` | Adapter diagnostics surfaced to the user, e.g. "step budget reached", "gdb could not read locals in this frame". |

`Shape`: `array` · `matrix` · `string` · `tuple` · `set` · `map` · `linked_list` ·
`doubly_linked_list` · `circular_linked_list` · `binary_tree` · `bst` · `nary_tree` ·
`directed_graph` · `undirected_graph` · `stack` · `queue` · `deque` · `object` · `unknown`

## 5. Structure inference

Inference runs in two layers and is always advisory.

**Static, before execution.** Parse class, struct and type declarations. A type with one field
referencing its own type suggests `linked_list`; two such fields named like `left`/`right` suggest
`binary_tree`; `next` plus `prev` suggests `doubly_linked_list`; a map from key to a collection of
keys suggests a graph adjacency list.

**Runtime, during execution.** Walk the live object graph from each root and measure it: out-degree
over self-type references, presence of cycles, whether any node is reachable by two paths, uniform
row lengths for nested sequences, ordering of keys.

Runtime evidence wins. A declaration that looks like a tree but whose instances contain a cycle is a
`directed_graph`, and the hint says so. Ordering invariants distinguish `bst` from a plain
`binary_tree`; access patterns (push/pop at one end only) distinguish `stack` and `queue` from `array`.

Every hint carries its `evidence` as human-readable strings, so the UI can explain *why* it drew
what it drew — and so a wrong guess is debuggable rather than mysterious. Unrecognized shapes emit
`unknown`, which renders as a generic object graph. **Inference never suppresses data.**

## 6. Opaque library calls

When execution enters code the user did not write, the adapter emits a single `frame_push` with
`kind: library`, suppresses all interior events, and emits `frame_pop` carrying the return value.
Mutations the library performs on objects the user can see are emitted on return, as `obj_set` /
`obj_resize` events attributed to the opaque call — so `list.sort()` visibly reorders the list
without exposing Timsort's internals.

Boundary determination per adapter: Python compares the frame's file against the user source path
and known stdlib/site-packages roots; JavaScript uses the instrumentation boundary (only user code
is instrumented, so library code is invisible by construction); C/C++ checks whether the frame has
debug info for a user file; Java filters on class name prefixes (`java.`, `javax.`, `jdk.`, `sun.`).

Step-into is offered only when readable source exists — pure Python and pure JavaScript. It is a
UI action that re-runs with a widened boundary, not a live capability.

## 7. Loop collapsing

Long loops are folded so the trace stays usable, and folding must work while streaming.

The collapser keeps a sliding window per active loop region. It retains the first *K* and last *K*
iterations in full detail (default *K* = 3). Iterations in between are dropped from the event stream
and replaced by a single `collapse` event.

**A `collapse` event is one composite, invertible step.** It carries the net effect of the folded
span: for every variable and every heap slot the span touched, the value before the span and the value
after it, plus the iteration count and summed metric deltas. Applying it forward jumps state to the
end of the span; applying its inverse restores state to the beginning. This is what keeps folding
compatible with the invertibility guarantee in §8 — without the net-effect record, backward stepping
across a fold would be reconstructing state from events that no longer exist.

The user loses the play-by-play inside a fold, never the resulting state. Expanding a collapsed region
in the UI is a re-run of just that region with folding disabled for it.

## 8. Snapshots and reverse stepping

Backward stepping applies inverse events, which works because every mutation carries `prev`.
Seeking to an arbitrary point uses the nearest preceding `snapshot`, then replays forward.

A `StateSnapshot` contains the frame stack with all bindings, the live heap, the active loop regions,
and metric totals.

Snapshots are **delta-encoded against the previous snapshot**, not written whole. A full snapshot of a
10,000-object heap is megabytes, and emitting that every 500 steps would make snapshots the dominant
cost of the trace — larger than the events they exist to accelerate. Each snapshot therefore records
only what changed since the last one, with a `base_seq` pointing at its predecessor and a periodic
`full: true` keyframe to bound how far a cold seek must walk.

The interval adapts to heap size rather than being fixed: cheap state gets frequent snapshots, large
heaps get fewer. The tuning target is the §NFR-1 seek budget at the lowest byte cost that meets it.

Both directions are pure state reconstruction. **The program is never re-executed for playback**,
which is what makes back-stepping instant and safe for programs with side effects.

## 9. Values

```
Value := { "prim": null | bool | int | float | string }   // immediate
        | { "ref": <obj id> }                              // heap reference
        | { "addr": "0x…", "type": "int*" }                // native pointer (C/C++)
        | { "unavailable": "<reason>" }                    // optimized out, unreadable
```

`unavailable` is deliberate. A debugger cannot always read a value, and the honest answer is better
than a fabricated one.

Floats carry `nan` / `inf` as strings. Integers exceeding IEEE-754 safe range are strings with a
`"bigint": true` sibling flag. Strings longer than 1 KB are truncated with `"truncated": <full_len>`.

## 10. Conformance

Adding a language means making it pass the shared suite, not inventing a new dialect.

Each adapter is verified against the same corpus of programs — assignment, arithmetic, branching,
loops with `break`/`continue`, function calls, recursion, mutation of a shared object, aliasing,
exceptions, stdin, linked list construction, tree insertion. For each program the adapter's trace
is checked for schema validity, monotonic `seq`, balanced frame push/pop, invertibility (replaying
forward to the end then inverting back to zero restores the initial state exactly), snapshot
agreement (every snapshot matches state derived by pure replay), and semantic expectations shared
across languages (the same loop reports the same iteration count everywhere).

## 11. Versioning

`schema: "flow_view/trace@1"`. Additive changes — new event types, new optional fields — stay at
version 1; consumers must ignore unknown event types and unknown fields. Removing or repurposing a
field is a major bump. The UI refuses to load a trace whose major version it does not implement,
and says so plainly.
