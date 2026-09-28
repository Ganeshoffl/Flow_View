/**
 * Does the heap view hold its performance budget?
 *
 * NFR-4 asks for 30 fps while animating up to 500 visible nodes, which means a layout plus inference
 * has to fit inside a 33 ms frame. These measure that on synthetic heaps of the shapes that cost the
 * most: a wide tree, a long chain, and a dense graph where the force layout has to do real work.
 *
 * Timing tests are usually a bad idea because they fail for reasons unrelated to the code. These are
 * kept because the budget is a stated requirement and because the margins are wide — a failure here
 * means something became algorithmically worse, not that the machine was briefly busy.
 */

import { describe, expect, it } from "vitest";

import type { Trace, TraceEvent } from "@flow-view/trace-schema";
import { collectAccess, inferStructures } from "@flow-view/inference";
import { TraceStore } from "@flow-view/trace-store";

import { layoutHeap } from "../src/layout.js";

/** One frame at 30 fps. */
const FRAME_BUDGET_MS = 33;

interface Built {
  readonly store: TraceStore;
}

/** A trace that allocates `count` linked objects of a given shape, with no execution around it. */
function synthesise(
  count: number,
  build: (emit: (event: TraceEvent) => void, ids: number[]) => void,
): Built {
  const events: TraceEvent[] = [];
  let seq = 0;
  let step = 0;
  const emit = (event: TraceEvent) => {
    events.push({ ...event, seq: seq++ } as TraceEvent);
  };

  emit({ seq: 0, t: "run_start" } as TraceEvent);
  emit({
    seq: 0,
    t: "frame_push",
    frame: 0,
    func: "<module>",
    args: [],
    kind: "user",
    recursion_depth: 0,
    line: 1,
    step: step++,
  } as TraceEvent);

  const ids: number[] = [];
  for (let index = 0; index < count; index++) {
    const obj = index + 1;
    ids.push(obj);
    emit({ seq: 0, t: "obj_new", obj, kind: "instance", type_name: "Node" } as TraceEvent);
  }

  build(emit, ids);

  emit({ seq: 0, t: "frame_pop", frame: 0, reason: "return", line: 1, step: step++ } as TraceEvent);
  emit({
    seq: 0,
    t: "run_end",
    status: "ok",
    exit_code: 0,
    steps: step,
    duration_ms: 1,
  } as TraceEvent);

  const trace: Trace = {
    schema: "flow_view/trace@1",
    session: {
      id: "perf",
      language: "python",
      language_version: "3.12.0",
      adapter_version: "0.1.0",
      profile: "full",
      source_files: [{ path: "main.py", sha256: "0".repeat(64), line_count: 1 }],
      entry: { path: "main.py", line: 1 },
      limits: { max_steps: 1e6, wall_ms: 1e6, memory_mb: 512, output_bytes: 1e6 },
      started_at: "2026-01-01T00:00:00Z",
    },
    events,
  };

  const store = new TraceStore();
  store.load(trace);
  store.fastForward();
  return { store };
}

function chain(count: number): Built {
  return synthesise(count, (emit, ids) => {
    ids.forEach((obj, index) => {
      emit({ seq: 0, t: "obj_set", obj, key: "v", value: { prim: index }, op: "set" } as TraceEvent);
      const next = ids[index + 1];
      emit({
        seq: 0,
        t: "obj_set",
        obj,
        key: "next",
        value: next === undefined ? { prim: null } : { ref: next },
        op: "set",
      } as TraceEvent);
    });
  });
}

function tree(count: number): Built {
  return synthesise(count, (emit, ids) => {
    ids.forEach((obj, index) => {
      emit({ seq: 0, t: "obj_set", obj, key: "k", value: { prim: index }, op: "set" } as TraceEvent);
      for (const [field, childIndex] of [
        ["left", index * 2 + 1],
        ["right", index * 2 + 2],
      ] as const) {
        const child = ids[childIndex];
        emit({
          seq: 0,
          t: "obj_set",
          obj,
          key: field,
          value: child === undefined ? { prim: null } : { ref: child },
          op: "set",
        } as TraceEvent);
      }
    });
  });
}

function denseGraph(count: number, degree: number): Built {
  return synthesise(count, (emit, ids) => {
    ids.forEach((obj, index) => {
      emit({ seq: 0, t: "obj_set", obj, key: "id", value: { prim: index }, op: "set" } as TraceEvent);
      for (let edge = 0; edge < degree; edge++) {
        const target = ids[(index + edge + 1) % ids.length];
        if (target === undefined) continue;
        emit({
          seq: 0,
          t: "obj_set",
          obj,
          key: `e${edge}`,
          value: { ref: target },
          op: "set",
        } as TraceEvent);
      }
    });
  });
}

/** How many times a measurement is repeated before the fastest is taken. */
const ATTEMPTS = 5;

/**
 * The best of several runs, not a single sample.
 *
 * A single sample measures the machine as much as the code. The 500-node tree case failed once at
 * 53 ms against a 33 ms budget and then passed on the next three full runs: the suite runs files in
 * parallel, so one measurement can land while several other workers are busy. That failure said
 * nothing about the layout code, and a test that cries wolf gets ignored — which is the same problem
 * as a test that cannot fail, arrived at from the other direction.
 *
 * The fastest run is the honest statistic here, because the question is whether the work *can* be done
 * inside a frame. Contention makes a run slower; nothing makes it spuriously faster, so a best-of-N
 * that still misses the budget means the algorithm genuinely got worse. The first run is discarded
 * separately, since it pays for lazy initialisation nobody pays twice.
 */
function timeLayout(built: Built): { ms: number; nodes: number } {
  const { store } = built;
  let best = Infinity;
  let nodes = 0;

  for (let attempt = 0; attempt <= ATTEMPTS; attempt++) {
    // Inference is measured together with layout, because a frame has to pay for both.
    const started = performance.now();
    const inference = inferStructures(store.state, { access: collectAccess(store) });
    const layout = layoutHeap({
      state: store.state,
      inferences: inference.byObject,
      language: "python",
    });
    const elapsed = performance.now() - started;
    nodes = layout.nodes.length;
    // Attempt 0 is a warm-up: it pays for JIT and lazy allocation that no later frame pays again.
    if (attempt > 0) best = Math.min(best, elapsed);
  }

  return { ms: best, nodes };
}

describe("layout stays inside a frame", () => {
  it("handles a 500-node chain", () => {
    const result = timeLayout(chain(500));
    expect(result.nodes).toBe(500);
    expect(result.ms, `${result.ms.toFixed(1)}ms for 500 chained nodes`).toBeLessThan(
      FRAME_BUDGET_MS,
    );
  });

  it("handles a 500-node tree", () => {
    const result = timeLayout(tree(500));
    expect(result.nodes).toBe(500);
    expect(result.ms, `${result.ms.toFixed(1)}ms for a 500-node tree`).toBeLessThan(
      FRAME_BUDGET_MS,
    );
  });

  it("handles a graph dense enough to need the force layout", () => {
    // The force layout is the expensive one: every pair repels, so cost grows with the square of the
    // node count. 120 nodes is where a user would still expect a picture rather than a warning.
    const result = timeLayout(denseGraph(120, 3));
    expect(result.nodes).toBeGreaterThan(100);
    expect(result.ms, `${result.ms.toFixed(1)}ms for a dense 120-node graph`).toBeLessThan(400);
  });
});

describe("cost grows sensibly", () => {
  it("scales close to linearly for a chain", () => {
    const small = timeLayout(chain(125)).ms;
    const large = timeLayout(chain(500)).ms;
    // Four times the nodes should not cost dramatically more than four times the time. A quadratic
    // step would show up here long before a user hit it.
    expect(large, `${small.toFixed(1)}ms at 125 vs ${large.toFixed(1)}ms at 500`).toBeLessThan(
      Math.max(small * 12, FRAME_BUDGET_MS),
    );
  });

  it("infers a large heap without stalling", () => {
    const { store } = tree(2000);
    const started = performance.now();
    const inference = inferStructures(store.state, { access: collectAccess(store) });
    const elapsed = performance.now() - started;
    expect(inference.byObject.size).toBe(2000);
    expect(elapsed, `${elapsed.toFixed(1)}ms to infer 2000 objects`).toBeLessThan(1500);
  });
});

describe("correctness does not lapse at scale", () => {
  it("still recognises a 500-node chain as a linked list", () => {
    const { store } = chain(500);
    const inference = inferStructures(store.state);
    const roots = [...inference.byObject.values()].filter((entry) => entry.root);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.shape).toBe("linked_list");
    expect(roots[0]?.members).toHaveLength(500);
  });

  it("still recognises a 500-node tree as a binary tree", () => {
    const { store } = tree(500);
    const inference = inferStructures(store.state);
    const root = [...inference.byObject.values()].find((entry) => entry.root);
    expect(["binary_tree", "bst"]).toContain(root?.shape);
  });

  it("draws every node of a large structure", () => {
    // Bounded work must never become quietly dropped work.
    const { store } = tree(500);
    const inference = inferStructures(store.state);
    const layout = layoutHeap({
      state: store.state,
      inferences: inference.byObject,
      language: "python",
    });
    expect(layout.nodes).toHaveLength(500);
  });
});
