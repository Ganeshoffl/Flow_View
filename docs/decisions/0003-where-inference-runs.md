# 3. Where structure inference runs

**Status:** accepted · **Phase:** 2, tasks 2.3–2.5

## The question

Something has to decide that a particular cluster of objects is a linked list rather than a tree.
`design.md` put that in the adapters, because `structure_hint` is an event and events come from
adapters.

Following that would mean writing the inference five times — once per language — and then keeping five
implementations agreeing about what a binary search tree is.

## Decision

**Runtime inference runs client-side, over the universal heap model.** Adapters may contribute
*static* hints from source, which are language-specific and which the client treats as weaker
evidence.

The reason is that runtime inference does not need anything language-specific. It asks: how many
same-type references does each node have, is there a cycle, is any node reachable by two paths, are
these rows all the same length, does this ordering hold. Every one of those questions is about the
trace's own heap model, which is identical for Python, JavaScript, C and Java by construction.

Doing it once means C++ gets tree detection the day its adapter can emit objects, with no tree code
written for C++. It also means an override can re-infer instantly, with no re-run, because the
evidence is already in the browser.

## What stays in the adapters

Static analysis, where it is worth anything. A Python class whose `__init__` assigns `self.next = None`
looks like a linked list node before a single instance exists — and when `head = None`, static
evidence is the *only* evidence there is. That reading depends on the language's syntax and
annotations, so it belongs where the parser is.

Adapters emit those as `structure_hint` events with `low` or `medium` confidence. The client
reconciles, and **runtime evidence wins**, which is what `trace-schema.md` §5 already required.

## Consequence for the schema

None. `structure_hint` remains an event an adapter may emit; the client now also produces inferences
of its own from the heap. The schema described who *may* emit hints, never who must.

## Cost accepted

The client now holds analysis logic, so `packages/inference` is a place bugs can live that is not a
renderer and not a store. The alternative was the same bugs in five languages at once.
