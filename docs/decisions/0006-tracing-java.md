# 0006 — Tracing Java with JDI, and what it costs

**Status:** accepted
**Date:** 2026-09-26

## The decision

Trace Java with the **Java Debug Interface** (`jdk.jdi`), driving the program in a second JVM, and read the
program's *structure* with **javac's Compiler Tree API** (`jdk.compiler`). Both ship inside the JDK, so the
adapter has no dependencies at all. It is a single source file, launched with `java Tracer.java`, so it has
no build step either.

This is the same shape as the Python adapter: a real execution facility for *what happened*, plus a parse of
the source for *what the code says*. Branch outcomes are observed by seeing which line runs next; the
condition's source text comes from the parse. A user's condition is never evaluated a second time.

## Why not instrument the source, as the JavaScript adapter does

Instrumentation would be roughly forty times faster. It was still rejected.

Java's grammar is several times larger than JavaScript's: lambdas, anonymous and local classes, records,
switch expressions, enhanced `for`, try-with-resources, static and instance initialisers, constructors,
varargs, labelled breaks, generics. Each is a shape that has to be handled, and the failure mode is not a
slow trace — it is a *wrong* one, or a program that no longer runs.

That is not hypothetical. The JavaScript adapter shipped with a scope bug that killed every program
containing a `let` inside a block: the inserted code named a variable that was no longer in scope, and the
user's own program died with a `ReferenceError`. Sixteen conformance cases did not catch it. Java offers more
places for that class of mistake, not fewer, and JDI has none of them: the JVM reports what happened, and no
line of the user's program is rewritten.

## What it costs, measured

Benchmarked before deciding, on a program executing 10,404 lines with three locals in scope on average:

| what the tracer does per step | per step | steps/sec |
|---|---|---|
| step only, read nothing | 0.157 ms | 6,350 |
| step, read the current line | 0.167 ms | 5,980 |
| step, read the line and every visible local | 0.517 ms | 1,930 |

The Python tracer covers the same program in 138 ms. **JDI is about forty times slower.**

Two things were tried and did not help. Caching each method's declared variables, so `visibleVariables()` is
not fetched every step, saved 4% — the cost is the suspend/resume round trip and `getValues`, not the lookup.
And the cached list still has to be filtered by scope, because `getValues` throws
`IllegalArgumentException: k is not valid at this frame location` for a variable that is not live at the
current instruction.

### What did help: not asking

Reading state costs two round trips; the step itself costs one. So the cheapest state to read is the state the
source says cannot have changed.

The traces already recorded the size of the prize. Counting steps that read everything and found nothing:

| case | steps | read and found nothing |
|---|---|---|
| recursion | 13 | 13 (100%) |
| linked-structure | 19 | 16 (84%) |
| exception-caught | 8 | 5 (62%) |
| branching | 5 | 3 (60%) |
| loop-break | 11 | 5 (45%) |
| *tight assignment loop* | 399 | 0 (0%) |

Outside tight loops, **half of all reads were wasted** — and the worst case was the heap, because an object
reachable from an unchanged local was re-walked on every single step. That is why `linked-structure` wasted 84%:
it re-read a five-node chain after lines that only compared two integers.

So the parse now also records, per line, whether that line could give a local a new value and whether it could
change an object in place. A line that can do neither is not observed at all. Measured on a program executing
8,854 steps:

| | wall time | per step | steps/sec |
|---|---|---|---|
| reading state after every line | 5,343 ms | 0.60 ms | 1,660 |
| reading it only when it can have changed | **3,509 ms** | **0.40 ms** | **2,520** |

**1.5× faster, and the trace is identical** — 16,959 events, byte for byte, differing only in their timestamps.
That equivalence is the point: the optimisation is allowed to change what the tracer *asks*, never what it
*reports*, and the conformance corpus and an event-by-event comparison both hold it to that.

Two rules keep it safe. Anything the scanner does not recognise is treated as able to change everything, so a
construct nobody thought about is slow rather than wrong. And any method call marks its line as mutating,
because a call may change anything it was handed.

## What that means for a user, stated rather than hidden

At roughly 2,500 steps per second:

- A pasted program of twenty to fifty lines executes a few hundred to a few thousand steps. It traces in
  under a second, and the difference from Python is invisible.
- A 30-second wall budget covers about 60,000 steps. So for Java the **wall clock**, not the step count, is
  the limit that usually bites, and a long loop ends with `status: "timeout"` and a note saying so.

Loop collapsing still applies, and still matters — it keeps a folded trace small enough for the browser. But
it does not make Java faster: folding discards *events*, and the JVM has already been stepped to produce
them. A collapsed Java loop costs the same time as an uncollapsed one.

This is a real difference between the languages, and the adapter says so instead of letting someone conclude
that flow_view has hung.

## Consequences

- Java requires a **JDK**, not a JRE: `jdk.jdi` and `javac` are both needed. The capability probe checks for
  each and names whichever is missing.
- A traced program is compiled with `javac -g` first. Without `-g` there are no local variable names, and the
  variables pane would be empty — so the flag is not optional, and a compile failure is reported as a result
  (the user's program did not compile) rather than as a tracer error.
- The program runs in a second JVM. Ceilings that the server applies to the child process do not
  automatically apply to the grandchild, so the JDI launch passes them on explicitly.
