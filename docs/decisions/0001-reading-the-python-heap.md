# 1. Reading the Python heap

**Status:** accepted · **Phase:** 1, task 1.0 · **Measured on:** CPython 3.12.13

## The question

The tracer must answer *what changed?* after every executed line. Python has no write barrier, so
the only way to know a list gained an element is to look at the list.

The design assumed a reachability-scoped walk per step would be affordable. That was an assumption,
and it was the one most likely to make the adapter unusable, so Phase 1 opens by measuring it
instead of arguing about it.

## What the measurement showed

Four heap shapes — a linked list, one flat list of instances, a balanced tree, and a dict-of-lists
adjacency map — at 100, 1,000 and 10,000 live objects. Per-step cost, median of 40 samples:

| strategy | 10k linked-list | 10k tree | 10k flat-list | 10k adjacency |
|---|---|---|---|---|
| full reachable walk + diff | 23,222µs | 29,747µs | 28,166µs | 29,494µs |
| bounded depth 3, 256 objects | 10.5µs | 41.7µs | **10,323µs** | 10,114µs |
| bounded + 32-slot window | 9.6µs | 39.3µs | 74.2µs | 63.2µs |
| line-scoped + bounded + window | 9.7µs | 42.8µs | 74.9µs | 61.9µs |
| a line that cannot mutate | 0.3µs | 0.3µs | 0.3µs | 0.3µs |

**The assumption was wrong.** A full walk costs ~28ms per step on a 10,000-object heap. A
10,000-step program would spend **284 seconds** in heap walking alone — 568× over budget. Scaling is
linear in heap size, exactly as feared.

**The fallback was also wrong.** Bounding depth and object count — the mitigation named in the
design — still cost 10ms on the flat list and the adjacency map. Capping *objects* does nothing
about fan-out *within* one object: a list of ten thousand elements is a single object at depth one
and ten thousand reads. That case was simply missing from the original reasoning.

## Decision

Three mechanisms, all of them necessary:

**1. A per-object slot window.** Read at most 32 entries from any one object, taking both ends of a
sequence rather than a prefix — a program appending to a list does its interesting work at the end,
and a prefix window would show a frozen head while the action happened out of sight. This is what
turned 10,323µs into 74µs, and it is the mechanism the original design lacked.

**2. Line-scoped roots.** A line can only mutate what it can reach, and what it can reach begins
with the names it writes down. `values[i] = x` can touch `values` and nothing else. Taking walk
roots from the executed line's own AST makes cost proportional to the statement rather than to the
program's data.

**3. Static mutation analysis.** A line containing no call, no subscript store, no attribute store
and no augmented assignment cannot mutate the heap. Those steps skip the walk entirely and cost a
0.3µs identity comparison of local bindings — a 30× to 250× saving on the many lines of a typical
program that only move primitives around.

Defaults: depth 3, 128 objects, 32 slots. `walk_full` remains available as an explicit
"show me everything" mode for small programs.

## Consequence: the performance requirement was wrong

NFR-3 originally claimed tracing overhead within roughly 100× native speed. That is not achievable
by any pure-Python tracer: `sys.settrace` alone costs more than that before any heap inspection, and
the figure was aspiration rather than analysis.

It is replaced by a **per-step budget of 100µs**, which is what the measurements support and what
actually matters to a user: at 74µs worst case, a 10,000-step program spends about 0.7s in heap
reading, and typical data shapes cost 10–40µs.

## What is accepted, and said out loud

Cost is now **independent of heap size**, which was the fatal property of the original design. What
remains is a bounded worst case of ~75µs when a line's root is an enormous single container.

The ceilings mean the heap view can be **incomplete**, and incompleteness must never be silent. A
walk that hits any ceiling sets `truncated`, and the adapter emits a `note` saying the view is
partial for that step. Structure beyond a frontier is still *referenced*, so nothing disappears from
the graph — contents fill in when a variable brings them closer.

One further consequence of the `Registry` holding strong references, so ids can never be recycled
onto different objects: the tracer extends the lifetime of objects the program has dropped. A
visualizer whose object identities silently shift is worse than one that uses more memory. The step
budget bounds how far this can go.

## Reproducing

```
python adapters/python/bench/heap_walk.py --sizes 100 1000 10000
```
