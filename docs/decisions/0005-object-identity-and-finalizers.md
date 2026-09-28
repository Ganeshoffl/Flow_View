# 5. Stable object ids cost faithful finalizers

**Status:** accepted, with the cost now stated out loud · **Phase:** 1, revisited while fixing Phase 4

## The question

The heap view needs an object to keep the same id for as long as the trace refers to it. `id()` in
CPython is an address, and addresses are reused the moment an object is freed — so an id handed out and
then recycled would make the heap view draw an arrow from one object to a completely different one that
happened to land at the same address. A visualizer that silently confuses two objects is worse than
useless; it is misleading in a way the reader cannot detect.

So `Registry` holds a strong reference to every object it has given an id to. An id can then never be
recycled while the trace still refers to it.

## What that actually costs

The docstring said this "extends the lifetime of objects the traced program has dropped" and framed the
trade as memory. That was underselling it, and the understatement survived three phases.

Holding a reference means the program's own `__del__` does not run when the program says it does.
Measured on `n = Noisy(); del n; print("after the del")`:

| | output |
|---|---|
| plain python | `gone` then `after the del` |
| flow_view | `after the del` |

The finalizer runs at interpreter shutdown, outside the traced region, so its output is **missing from
the trace** rather than merely late. A reader watching their own `__del__` would conclude it never ran —
which, for a tool whose whole purpose is showing what a program does, is the worst category of bug.

## Decision

**Keep the strong references. Say so, per occurrence, in the trace.**

The adapter finds `__del__` definitions in the source and emits a `note` naming the line, explaining
that the finalizer will not run where it would outside flow_view and that its output may be absent. A
program with no `__del__` — almost all of them — sees nothing.

Warning is not a fix, and it is not offered as one. It is chosen because the alternative available today
is worse than the problem: see below.

## What a real fix requires, and why it is not here

Weak references would let objects die on time. Two things stand in the way, and neither is small:

1. **Most containers cannot be weakly referenced.** `list`, `dict`, `tuple`, `int` and `str` do not
   support `weakref` in CPython. Only user-defined classes do — which, conveniently, is exactly the
   `__del__` case, so a hybrid would work: weak references where the type allows, strong where it does
   not, since a builtin has no user finalizer to delay.

2. **The death callback fires anywhere.** Dropping an object's id needs an `obj_free` event, and a
   weakref callback runs at whatever instruction happened to release the last reference — possibly
   inside the tracer's own callbacks, possibly mid-statement, possibly during collection of a cycle.
   Emitting trace events from there is a re-entrancy problem of the same family as the three buffering
   bugs in decision 0004, and those took a day to find because each looked like a performance detail.

The hybrid is the right design and it belongs in its own change, with tests that force a death at a
known point rather than hoping one happens. Doing it in passing, while fixing unrelated flaws, is how
the buffering bugs got written in the first place.

## Consequences

- `SourceAnalysis.finalizer_lines` exists, so the warning is a static fact about the program rather than
  something discovered at runtime.
- The warning is emitted once per definition, not deduplicated, because two classes with finalizers are
  two separate things the reader needs to know about.
- Object ids remain trustworthy, which was the property worth protecting. Nothing in the heap view, the
  inference, or the aliasing tests has to reason about an id changing meaning.
- Every future adapter meets the same fork. A JavaScript adapter has no finalizers to worry about; a
  C++ adapter has destructors that run deterministically and must not be delayed, so it will need the
  weak-reference design rather than this compromise.
