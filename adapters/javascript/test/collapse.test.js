/**
 * Folding, checked at the level where it is decided.
 *
 * The collapser is a pure function of an event stream, which is exactly what makes it testable without a
 * running program: feed it events, read what comes out. The properties below are the ones that hurt when
 * broken — losing visible behaviour, and losing the ability to step backwards across a fold.
 */

import { describe, expect, it } from "vitest";

import { LoopCollapser } from "../src/collapse.js";

/** Run a whole stream through a collapser and return what it chose to emit. */
function through(events, options = {}) {
  const collapser = new LoopCollapser({ seq: () => 0, ...options });
  const out = [];
  for (const [kind, payload] of events) out.push(...collapser.feed(kind, payload));
  out.push(...collapser.drain());
  return { out, collapser };
}

/** A loop of `count` iterations, each advancing `total` by its index. */
function loop(count, { region = 1, extraPerIteration = () => [] } = {}) {
  const events = [["loop_enter", { region, line_start: 1, line_end: 3 }]];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const before = total;
    total += i;
    events.push(["loop_iter", { region, i }]);
    events.push(["step_line", { frame: 0, line: 2 }]);
    events.push([
      "var_set",
      { frame: 0, name: "total", value: { prim: total }, prev: { prim: before }, line: 2 },
    ]);
    events.push(["metric", { name: "iteration", delta: 1 }]);
    events.push(...extraPerIteration(i));
  }
  events.push(["loop_exit", { region, iterations: count, reason: "condition" }]);
  return { events, total };
}

const kinds = (out) => out.map(([kind]) => kind);
const collapses = (out) => out.filter(([kind]) => kind === "collapse").map(([, payload]) => payload);

describe("when folding is not worth it", () => {
  it("leaves a short loop exactly as it was", () => {
    const { events } = loop(5);
    const { out } = through(events, { minIterations: 20 });
    expect(out).toEqual(events);
  });

  it("leaves a loop at the threshold alone", () => {
    const { events } = loop(20);
    const { out } = through(events, { minIterations: 20 });
    expect(kinds(out)).not.toContain("collapse");
  });
});

describe("when folding happens", () => {
  it("keeps the head and the tail verbatim and folds the middle", () => {
    const { events } = loop(60);
    const { out } = through(events, { minIterations: 20, keepHead: 3, keepTail: 3 });

    const iterIndices = out
      .filter(([kind]) => kind === "loop_iter")
      .map(([, payload]) => payload.i);

    // Everything up to the minimum runs verbatim, then the last three.
    expect(iterIndices.slice(0, 20)).toEqual([...Array(20).keys()]);
    expect(iterIndices.slice(-3)).toEqual([57, 58, 59]);
    expect(collapses(out)).toHaveLength(1);
  });

  it("carries the net effect of the span, so it can be stepped backwards", () => {
    // This is the property the whole design turns on: a fold has to know where the span started and where
    // it ended, or a reader can move forward over it and never back.
    const { events } = loop(60);
    const { out } = through(events, { minIterations: 20, keepHead: 3, keepTail: 3 });
    const [fold] = collapses(out);

    const effect = fold.effects.find((e) => e.key === "total");
    expect(effect.kind).toBe("var");
    expect(effect.frame).toBe(0);

    // Iterations 0..19 run verbatim because of the threshold, then 20..55 are folded, then 56..59 survive:
    // the tail window holds three finished iterations plus the one still in progress, so four reach the end
    // intact. The Python adapter keeps four for the same reason, which is why case 016 reports to_iter 495
    // of 500 in both.
    expect(fold.from_iter).toBe(20);
    expect(fold.to_iter).toBe(55);
    expect(fold.iterations).toBe(36);

    // `total` entered the span holding the sum of 0..19 and left holding the sum of 0..55.
    const sumBelow = (n) => (n * (n - 1)) / 2;
    expect(effect.before).toEqual({ prim: sumBelow(20) });
    expect(effect.after).toEqual({ prim: sumBelow(56) });
  });

  it("sums the work it swallowed instead of discarding it", () => {
    // Folding hides steps, not effort. A metrics pane fed only the surviving events would under-report what
    // the program actually did.
    const { events } = loop(60);
    const { out } = through(events, { minIterations: 20, keepHead: 3, keepTail: 3 });
    const verbatim = out
      .filter(([kind]) => kind === "metric")
      .reduce((sum, [, payload]) => sum + payload.delta, 0);
    const folded = collapses(out).reduce((sum, fold) => sum + (fold.metrics?.iteration ?? 0), 0);
    expect(verbatim + folded).toBe(60);
  });

  it("emits more than one fold once a chunk fills, so the trace keeps flowing", () => {
    const { events } = loop(200);
    const { out } = through(events, { minIterations: 20, keepHead: 3, keepTail: 3, chunk: 50 });
    expect(collapses(out).length).toBeGreaterThan(1);
    for (const fold of collapses(out)) expect(fold.iterations).toBeLessThanOrEqual(50);
  });

  it("accounts for every iteration exactly once", () => {
    const { events } = loop(200);
    const { out } = through(events, { minIterations: 20, keepHead: 3, keepTail: 3, chunk: 50 });
    const kept = out.filter(([kind]) => kind === "loop_iter").length;
    const folded = collapses(out).reduce((sum, fold) => sum + fold.iterations, 0);
    expect(kept + folded).toBe(200);
  });
});

describe("what folding refuses to swallow", () => {
  it("gives up on a loop that prints", () => {
    // Output is behaviour. A summary cannot stand in for it, so the loop is left alone rather than
    // approximated.
    const { events } = loop(60, {
      extraPerIteration: (i) => (i === 30 ? [["stdout", { text: `${i}\n`, frame: 0 }]] : []),
    });
    const { out } = through(events, { minIterations: 20, keepHead: 3, keepTail: 3 });

    expect(out.filter(([kind]) => kind === "stdout")).toHaveLength(1);

    const iterIndices = out.filter(([kind]) => kind === "loop_iter").map(([, p]) => p.i);
    const folded = collapses(out).reduce((sum, fold) => sum + fold.iterations, 0);

    // Iterations folded *before* the print was seen stay folded — discarding them would lose the state they
    // carried. What matters is that nothing is lost either way: every iteration is either still itself or
    // accounted for inside a fold.
    expect(iterIndices.length + folded).toBe(60);
    // The iteration that printed, and everything after it, survives verbatim.
    expect(iterIndices).toContain(30);
    expect(iterIndices.filter((i) => i >= 30)).toEqual(
      [...Array(60).keys()].filter((i) => i >= 30),
    );
    // No fold may cover the printing iteration.
    for (const fold of collapses(out)) expect(fold.to_iter).toBeLessThan(30);
  });

  it("gives up on a loop that allocates", () => {
    const { events } = loop(60, {
      extraPerIteration: (i) =>
        i === 40 ? [["obj_new", { obj: 7, kind: "list", type_name: "Array" }]] : [],
    });
    const { out } = through(events, { minIterations: 20, keepHead: 3, keepTail: 3 });
    expect(out.filter(([kind]) => kind === "obj_new")).toHaveLength(1);

    const iterIndices = out.filter(([kind]) => kind === "loop_iter").map(([, p]) => p.i);
    const folded = collapses(out).reduce((sum, fold) => sum + fold.iterations, 0);
    expect(iterIndices.length + folded).toBe(60);
    for (const fold of collapses(out)) expect(fold.to_iter).toBeLessThan(40);
  });

  it("gives up rather than losing an exception", () => {
    const { events } = loop(60, {
      extraPerIteration: (i) =>
        i === 45 ? [["exception_raise", { type: "RangeError", message: "no" }]] : [],
    });
    const { out } = through(events, { minIterations: 20, keepHead: 3, keepTail: 3 });
    expect(out.filter(([kind]) => kind === "exception_raise")).toHaveLength(1);
  });

  it("still describes what it had already folded when it gives up", () => {
    // Giving up halfway must not discard the spans already summarised, or their state changes vanish and
    // replay ends up with the wrong values.
    const { events } = loop(300, {
      extraPerIteration: (i) => (i === 250 ? [["stdout", { text: "late\n", frame: 0 }]] : []),
    });
    const { out } = through(events, { minIterations: 20, keepHead: 3, keepTail: 3, chunk: 50 });

    const kept = out.filter(([kind]) => kind === "loop_iter").length;
    const folded = collapses(out).reduce((sum, fold) => sum + fold.iterations, 0);
    expect(kept + folded).toBe(300);
    expect(out.filter(([kind]) => kind === "stdout")).toHaveLength(1);
  });
});

describe("loops that never close", () => {
  it("hands back everything it was holding", () => {
    // A run stopped by a budget leaves its loop open. Anything still buffered belongs in the trace.
    const { events } = loop(60);
    const truncated = events.slice(0, -1); // drop loop_exit
    const { out } = through(truncated, { minIterations: 20, keepHead: 3, keepTail: 3 });
    const kept = out.filter(([kind]) => kind === "loop_iter").length;
    const folded = collapses(out).reduce((sum, fold) => sum + fold.iterations, 0);
    expect(kept + folded).toBe(60);
  });
});

describe("events outside any loop", () => {
  it("passes them straight through", () => {
    const { out } = through([
      ["run_start", {}],
      ["step_line", { frame: 0, line: 1 }],
      ["stdout", { text: "hi\n" }],
    ]);
    expect(kinds(out)).toEqual(["run_start", "step_line", "stdout"]);
  });
});
