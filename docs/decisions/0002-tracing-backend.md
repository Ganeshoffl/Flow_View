# 2. Which tracing mechanism

**Status:** accepted · **Phase:** 1, task 1.8 · **Measured on:** CPython 3.12.13

## The plan, and why it was wrong

Task 1.8 read: *"`sys.monitoring` fast path on 3.12+, `settrace` fallback below it, identical output
from both."* It assumed monitoring is a straight win where it exists.

Both halves of that turned out to be false. The two mechanisms **cannot** produce identical output,
and the speed difference does not justify caring.

## What monitoring actually costs and buys

| workload | settrace | monitoring | ratio |
|---|---|---|---|
| tight loop, 1204 steps | 12.1ms | 11.1ms | 1.09× |
| heap building, 604 steps | 33.8ms | 29.2ms | 1.16× |
| repeated library calls, 725 steps | 24.4ms | 22.9ms | 1.07× |

Roughly a tenth faster. Against that:

**Monitoring hides single-line loops.** `LINE` fires when execution moves *to* a line, not every time
it re-enters one. So for `sq = [i * i for i in range(3)]`, settrace reports four line events — the
comprehension's three iterations and the statement itself — and monitoring reports one. The same is
true of `for i in range(3): t += i`.

That is the whole point of the tool. A visualizer that collapses a loop into a single step, in order
to save 10%, has traded away the thing the user came for.

**Choosing per version would make traces version-dependent.** The same program would produce
different step counts on 3.11 and 3.12. A user following a tutorial would see something that does not
match, with no way to tell why.

## Decision

**`settrace` is the default on every version.** `MonitoringBackend` remains, selectable with
`backend="monitoring"`, for anyone who wants the speed and accepts a coarser trace. The conformance
suite asserts both that the two agree everywhere else and that they diverge on exactly the two
constructs named above — so if CPython changes, a test says so rather than a user noticing.

## A bug worth recording

Monitoring first appeared to be **5× faster** on library-heavy code. It was not. `sys.monitoring.DISABLE`
turns an event off *permanently for a code location*, so disabling `PY_START` for `json.dumps` after
the first call meant the next seventy-nine were never reported. 480 missing steps, and a trace
claiming one library call where the program made eighty.

The apparent speedup was silently dropped work. `DISABLE` is now used only for `LINE` events inside
library frames, where "never tell me about this location again" is genuinely what is meant.

The general lesson: a performance result that looks too good is a correctness question first.

## What the work was still worth

Getting here required splitting notification from interpretation. Each backend now only translates
its own protocol into calls on the tracer; every decision about what an event *means* lives in one
place. That is why the two agree on twelve of fourteen constructs rather than drifting apart, and it
is the shape the JavaScript adapter will need when it has both an instrumentation path and a
debugger-protocol path available.

Two real bugs also surfaced, both of which affected the default path:

- The tracer recorded its own teardown. `backend.uninstall()` necessarily runs while tracing is still
  live, and `backends.py` was missing from the tracer's internal-module list, so every trace ended
  with a frame for `uninstall` and a heap object for the backend.
- Generators. settrace reports a yield as a return and a resume as a call; monitoring reports them
  separately, and the mapping had to be made explicit rather than assumed.

## Reproducing

```
python conformance/backends.py
```
