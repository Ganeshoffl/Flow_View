/**
 * NFR-1: stepping, back-stepping and seeking inside 50 ms at 100,000 retained steps.
 *
 * This was an unmeasured claim for four phases. The Phase 4 gate names the number, the store's own
 * `seekEvent` carried a comment saying acceleration was still to come, and nobody had checked what
 * "still to come" actually cost. So: measure first, decide after.
 *
 * Stepping one at a time and seeking to an arbitrary point are different problems. Stepping is O(1)
 * whatever the trace length, because an event carries its own inverse. Seeking is where the cost is,
 * because reaching step 50,000 from step 0 means applying 50,000 events unless something shortens it.
 */

import { describe, expect, it } from "vitest";

import type { Trace, TraceEvent } from "@flow-view/trace-schema";

import { TraceStore } from "../src/store.js";
import { captureState, compareStates } from "../src/snapshot.js";

/** One frame at 30 fps, which is the budget a single step has to fit inside. */
const STEP_BUDGET_MS = 50;

/** NFR-1's stated size. */
const RETAINED_STEPS = 100_000;

/**
 * A long trace with the cheapest possible events.
 *
 * Deliberately minimal: one line step and one assignment per iteration. Anything richer would measure
 * the heap model rather than the cost of walking the journal, and walking the journal is what a seek
 * does.
 */
function longTrace(steps: number): Trace {
  const events: TraceEvent[] = [];
  let seq = 0;
  let step = 0;
  const push = (event: Partial<TraceEvent>) => {
    events.push({ ...event, seq: seq++ } as TraceEvent);
  };

  push({ t: "run_start" });
  push({
    t: "frame_push",
    frame: 0,
    func: "<module>",
    args: [],
    kind: "user",
    recursion_depth: 0,
    line: 1,
    step: step++,
  });

  let total = 0;
  for (let i = 0; i < steps; i++) {
    push({ t: "step_line", frame: 0, line: 2, path: "main.py", step: step++ });
    const previous = total;
    total += i;
    push({
      t: "var_set",
      frame: 0,
      name: "total",
      value: { prim: total },
      prev: { prim: previous },
      scope: "local",
    });
  }
  push({ t: "frame_pop", frame: 0, reason: "return", line: 2, step: step++ });
  push({ t: "run_end", status: "ok", exit_code: 0, steps: step, duration_ms: 1 });

  return {
    schema: "flow_view/trace@1",
    session: {
      id: "bench",
      language: "python",
      language_version: "3.12.0",
      adapter_version: "0.1.0",
      profile: "full",
      source_files: [{ path: "main.py", sha256: "0".repeat(64), line_count: 3 }],
      entry: { path: "main.py", line: 1 },
      limits: { max_steps: steps * 4, wall_ms: 600000, memory_mb: 512, output_bytes: 1048576 },
      started_at: "2026-01-01T00:00:00Z",
    },
    events,
  } as Trace;
}

/** Best of several attempts, for the reasons given in renderers/test/performance.test.ts. */
function fastest(attempts: number, work: () => void): number {
  let best = Infinity;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    const started = performance.now();
    work();
    const elapsed = performance.now() - started;
    if (attempt > 0) best = Math.min(best, elapsed);
  }
  return best;
}

const trace = longTrace(RETAINED_STEPS);
const store = new TraceStore();
store.load(trace);

describe(`a trace of ${RETAINED_STEPS.toLocaleString()} steps`, () => {
  it("holds the number of steps it was given", () => {
    expect(store.stepCount).toBeGreaterThanOrEqual(RETAINED_STEPS);
  });

  it("steps forward well inside the budget", () => {
    store.seekStep(RETAINED_STEPS / 2);
    const ms = fastest(20, () => store.next());
    expect(ms, `${ms.toFixed(3)}ms to step forward`).toBeLessThan(STEP_BUDGET_MS);
  });

  it("steps backward well inside the budget", () => {
    store.seekStep(RETAINED_STEPS / 2);
    const ms = fastest(20, () => store.prev());
    expect(ms, `${ms.toFixed(3)}ms to step back`).toBeLessThan(STEP_BUDGET_MS);
  });

  it("steps forward and back repeatedly without drifting", () => {
    store.seekStep(RETAINED_STEPS / 2);
    const before = store.state.step;
    for (let i = 0; i < 500; i++) store.next();
    for (let i = 0; i < 500; i++) store.prev();
    expect(store.state.step).toBe(before);
  });

  it("seeks to a nearby step inside the budget", () => {
    store.seekStep(RETAINED_STEPS / 2);
    const ms = fastest(10, () => store.seekStep(RETAINED_STEPS / 2 + 50));
    expect(ms, `${ms.toFixed(3)}ms to seek 50 steps away`).toBeLessThan(STEP_BUDGET_MS);
  });

  it("drags the playback bar inside the budget", () => {
    // Dragging arrives as many small seeks rather than one big one, and each has to fit in a frame.
    store.seekStep(1000);
    const ms = fastest(5, () => {
      for (let at = 1000; at < 6000; at += 250) store.seekStep(at);
    });
    expect(ms, `${ms.toFixed(1)}ms to drag across 5000 steps in 250-step increments`).toBeLessThan(
      STEP_BUDGET_MS,
    );
  });
});

/**
 * The long jump: met once the trace has been played through, which is the normal path.
 *
 * Seeking used to be sequential replay, so reaching the far end of a 100,000-step trace meant applying
 * every event in between — 43ms with one assignment per step and 111ms with four, against a 50ms budget.
 *
 * Keyframes fix it for any trace that has been walked forward once, and a live run always has been,
 * because the playhead follows the streaming edge. Measured:
 *
 *              cold      warm
 *   light     42.7ms     0.9ms
 *   heavy    163.2ms     0.6ms
 *
 * Cold means a saved trace loaded and jumped to the far end without ever being played. That case still
 * misses on a dense trace, and keyframes cannot help it: they are only captured moving forward, because
 * the undo journal behind one has to have been built on the way past it. Closing it needs the `snapshot`
 * events the schema defines and the adapter does not yet emit — the rest of task 4.5.
 */
describe("a full-length jump", () => {
  const COLD_CEILING_MS = 250;

  it("costs no more than it did when nothing has been played yet", () => {
    const local = new TraceStore();
    local.load(longTrace(RETAINED_STEPS));
    const last = RETAINED_STEPS - 1;

    let best = Infinity;
    for (let trial = 0; trial <= 3; trial++) {
      local.seekStep(0);
      const started = performance.now();
      local.seekStep(last);
      const elapsed = performance.now() - started;
      if (trial > 0) best = Math.min(best, elapsed);
    }

    expect(
      best,
      `${best.toFixed(1)}ms cold; the remaining gap needs adapter-emitted snapshots`,
    ).toBeLessThan(COLD_CEILING_MS);
  });

  it("lands in exactly the state sequential stepping would", () => {
    const jumped = new TraceStore();
    jumped.load(longTrace(2000));
    jumped.seekStep(1500);

    const stepped = new TraceStore();
    stepped.load(longTrace(2000));
    stepped.seekStep(0);
    while (stepped.state.step < 1500) stepped.next();

    expect(compareStates(jumped.state, stepped.state)).toEqual([]);
  });
});

describe("seeking by keyframe lands exactly where replaying would", () => {
  const STEPS = 6000;

  /** A store that has walked the whole trace once, so keyframes exist. */
  function warmed(): TraceStore {
    const store = new TraceStore();
    store.load(longTrace(STEPS));
    store.fastForward();
    return store;
  }

  /** A store that replays to a target from scratch, one event at a time. */
  function replayedTo(step: number): TraceStore {
    const store = new TraceStore();
    store.load(longTrace(STEPS));
    store.seekStep(0);
    while (store.state.step < step) store.next();
    return store;
  }

  it.each([1, 17, 500, 2001, 2999, 4000, 5999])("matches replay at step %i", (step) => {
    const jumped = warmed();
    jumped.seekStep(step);
    const stepped = replayedTo(step);
    expect(compareStates(jumped.state, stepped.state)).toEqual([]);
  });

  it("matches replay after jumping backwards and forwards repeatedly", () => {
    const store = warmed();
    for (const step of [5000, 100, 4500, 12, 3000, 2999, 1]) store.seekStep(step);
    const stepped = replayedTo(1);
    expect(compareStates(store.state, stepped.state)).toEqual([]);
  });

  it("can still step backwards one at a time after restoring a keyframe", () => {
    // The reason keyframes are only captured moving forwards: the undo journal behind one was built on
    // the way past it. If that were not true, this would drift.
    const store = warmed();
    store.seekStep(4000);
    for (let i = 0; i < 300; i++) store.prev();
    const stepped = replayedTo(4000 - 300);
    expect(compareStates(store.state, stepped.state)).toEqual([]);
  });

  it("rewinds to a genuinely empty state", () => {
    const store = warmed();
    store.seekStep(3000);
    store.rewind();
    expect(store.state.frames.size).toBe(0);
    expect(store.state.objects.size).toBe(0);
    expect(store.state.step).toBe(-1);
  });

  it("does not let the live state share structure with a keyframe", () => {
    // Restoring must hand out copies. Sharing would mean the next mutation quietly rewrote the keyframe,
    // and the seek after that would land somewhere that never existed.
    const store = warmed();
    store.seekStep(2500);
    const firstVisit = captureState(store.state);
    store.seekStep(5500);
    store.seekStep(2500);
    expect(compareStates(store.state, { ...store.state })).toEqual([]);
    const secondVisit = captureState(store.state);
    expect(secondVisit).toEqual(firstVisit);
  });

  it("keeps a long trace's keyframes bounded", () => {
    const store = new TraceStore();
    store.load(longTrace(60_000));
    store.fastForward();
    const held = (store as unknown as { keyframes: unknown[] }).keyframes.length;
    expect(held).toBeGreaterThan(0);
    expect(held, `${held} keyframes retained`).toBeLessThanOrEqual(32);
  });
});

describe("a full-length jump, now that keyframes exist", () => {
  it("is inside the NFR-1 budget once the trace has been watched once", () => {
    const store = new TraceStore();
    store.load(longTrace(RETAINED_STEPS));
    store.fastForward();
    const last = RETAINED_STEPS - 1;

    let best = Infinity;
    for (let trial = 0; trial <= 4; trial++) {
      store.seekStep(0);
      const started = performance.now();
      store.seekStep(last);
      const elapsed = performance.now() - started;
      if (trial > 0) best = Math.min(best, elapsed);
    }

    expect(best, `${best.toFixed(1)}ms for a full-length forward jump`).toBeLessThan(STEP_BUDGET_MS);
  });
});
