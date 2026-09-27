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
import { compareStates } from "../src/snapshot.js";

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
 * The one operation that does not fit, measured rather than assumed.
 *
 * Seeking is sequential replay: reaching the far end of a 100,000-step trace means applying every
 * event in between. Measured here, on a trace with one assignment per step, a full-length forward jump
 * costs around 43 ms — inside the budget only because the trace is about as cheap as a trace can be.
 * With four events per step, closer to a real program, it is around 110 ms.
 *
 * So the Phase 4 gate ("seek latency stays inside the 50 ms budget at 100k retained steps") is **not
 * met** for a single long-distance jump, and saying so is more useful than choosing a trace thin
 * enough to pass. Everything else is comfortable: stepping is microseconds because every event carries
 * its own inverse, and dragging is a succession of short seeks.
 *
 * The fix is task 4.5, snapshot-accelerated seeking, and it needs the adapter to emit the `snapshot`
 * events the schema already defines — the store has `captureState` but nothing that restores one, so
 * there is no shortcut to bolt on here. Until then this test pins the current cost with a ceiling well
 * above it, so the number cannot quietly get worse while the real fix waits.
 */
describe("a full-length jump: the part of NFR-1 that is not met yet", () => {
  const CURRENT_CEILING_MS = 250;

  it("costs more than the budget, and no more than it did", () => {
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
      `${best.toFixed(1)}ms for a full-length forward jump; the target is ${STEP_BUDGET_MS}ms ` +
        "and needs task 4.5 (snapshot-accelerated seeking)",
    ).toBeLessThan(CURRENT_CEILING_MS);
  });

  it("lands in exactly the state sequential stepping would", () => {
    // Whatever the cost, the answer has to be right - and it is the thing an acceleration could
    // plausibly break, so it is pinned before anyone accelerates it.
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
