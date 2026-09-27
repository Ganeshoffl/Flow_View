/**
 * Moving around a trace.
 *
 * Stepping, seeking and jumping to a change are the controls a user actually spends their time in, and
 * they have to agree with each other. The property that matters most is that there is exactly one
 * answer to "where is the playhead at step N" — reaching a step by stepping forward, by rewinding to
 * it, or by seeking directly must all produce the same state. They did not, once: `next` stopped the
 * moment it applied a landable event while `seekStep` went on to apply that step's effects, so the
 * same step had two different states depending on the route taken.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Trace } from "@flow-view/trace-schema";
import { isRef } from "@flow-view/trace-schema";

import { TraceStore } from "../src/store.js";
import { captureState } from "../src/snapshot.js";
import { focusFrame } from "../src/state.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "narration",
  "test",
  "fixtures",
);

function load(name: string): TraceStore {
  const trace = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Trace;
  const store = new TraceStore();
  store.load(trace);
  return store;
}

describe("one position per step", () => {
  it("stepping forward and seeking directly agree", () => {
    for (const name of ["bubble-sort", "recursion", "exception"]) {
      const stepped = load(name);
      const sought = load(name);
      let step = 0;
      while (stepped.next()) {
        sought.seekStep(stepped.state.step);
        expect(
          captureState(sought.state),
          `${name}: step ${stepped.state.step} differs between stepping and seeking`,
        ).toEqual(captureState(stepped.state));
        step++;
        if (step > 200) break;
      }
      expect(step).toBeGreaterThan(5);
    }
  });

  it("stepping back and seeking directly agree", () => {
    const store = load("bubble-sort");
    store.fastForward();
    const reference = load("bubble-sort");
    let guard = 0;
    while (store.prev() && guard++ < 200) {
      if (store.state.step < 0) break;
      reference.seekStep(store.state.step);
      expect(
        captureState(reference.state),
        `step ${store.state.step} differs between stepping back and seeking`,
      ).toEqual(captureState(store.state));
    }
  });

  it("walking forward then back returns to the start", () => {
    const store = load("recursion");
    let forwards = 0;
    while (store.next()) forwards++;
    let backwards = 0;
    while (store.prev()) backwards++;
    expect(forwards).toBeGreaterThan(5);
    expect(store.isAtStart).toBe(true);
    expect(backwards).toBe(forwards);
  });
});

describe("frame-aware stepping", () => {
  it("step into reaches the called function", () => {
    const store = load("recursion");
    let guard = 0;
    while (guard++ < 50) {
      if (!store.stepInto()) break;
      if (focusFrame(store.state)?.func === "fact") break;
    }
    expect(focusFrame(store.state)?.func).toBe("fact");
  });

  it("step out returns to the caller", () => {
    const store = load("recursion");
    while (store.stepInto() && focusFrame(store.state)?.func !== "fact") {
      // walk in
    }
    const depth = store.state.frameOrder.length;
    expect(store.stepOut()).toBe(true);
    expect(store.state.frameOrder.length).toBeLessThan(depth);
  });

  it("step over does not descend into a call", () => {
    const store = load("recursion");
    // Get to the line that calls fact.
    while (store.next() && (store.currentEvent()?.line ?? 0) < 6) {
      // walk to the print line
    }
    const depth = store.state.frameOrder.length;
    store.stepOver();
    expect(store.state.frameOrder.length).toBeLessThanOrEqual(depth);
  });
});

describe("jumping to a change", () => {
  it("moves forward to the next time a variable changes", () => {
    const store = load("bubble-sort");
    store.next();
    const frame = focusFrame(store.state)?.frame ?? 0;

    const moved = store.seekChange({ kind: "variable", frame, name: "j" }, 1);
    expect(moved, "there should be a change of j to jump to").toBe(true);
    expect(focusFrame(store.state)?.bindings.has("j")).toBe(true);
  });

  it("moves backward to the previous change", () => {
    const store = load("bubble-sort");
    store.fastForward();
    const frame = focusFrame(store.state)?.frame ?? 0;
    const before = store.position;

    const moved = store.seekChange({ kind: "variable", frame, name: "j" }, -1);
    expect(moved).toBe(true);
    expect(store.position).toBeLessThan(before);
  });

  it("reports honestly when there is nothing to jump to", () => {
    const store = load("bubble-sort");
    store.fastForward();
    const frame = focusFrame(store.state)?.frame ?? 0;
    expect(store.seekChange({ kind: "variable", frame, name: "nonexistent" }, 1)).toBe(false);
  });

  it("finds successive changes rather than sticking on one", () => {
    const store = load("bubble-sort");
    store.next();
    const frame = focusFrame(store.state)?.frame ?? 0;
    const positions: number[] = [];
    for (let i = 0; i < 4; i++) {
      if (!store.seekChange({ kind: "variable", frame, name: "j" }, 1)) break;
      positions.push(store.position);
    }
    expect(positions.length).toBeGreaterThanOrEqual(3);
    // Strictly increasing: a jump that landed on the same event twice would be a trap for the user.
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it("jumps to a heap object's next mutation", () => {
    const store = load("bubble-sort");
    store.fastForward();
    const values = focusFrame(store.state)?.bindings.get("values");
    expect(values && isRef(values)).toBe(true);
    const objId = isRef(values!) ? values.ref : -1;

    store.rewind();
    expect(store.seekChange({ kind: "object", obj: objId }, 1)).toBe(true);
  });
});

describe("bounds", () => {
  it("does not step past the end", () => {
    const store = load("exception");
    let guard = 0;
    while (store.next() && guard++ < 500) {
      // walk to the end
    }
    expect(store.next()).toBe(false);
    expect(store.isAtEnd).toBe(true);
  });

  it("does not step before the start", () => {
    const store = load("exception");
    expect(store.prev()).toBe(false);
    expect(store.isAtStart).toBe(true);
  });

  it("clamps a seek beyond either end", () => {
    const store = load("exception");
    store.seekStep(99_999);
    expect(store.state.step).toBeLessThan(store.stepCount);
    store.seekStep(-5);
    expect(store.state.step).toBeGreaterThanOrEqual(0);
  });

  it("applies the tail after the last step", () => {
    // run_end and its notes come after the final landable event, and a run that looked unfinished at
    // the end of its own trace would be a confusing place to leave someone.
    const store = load("exception");
    while (store.next()) {
      // walk to the end
    }
    expect(store.state.status).toBeDefined();
  });
});
