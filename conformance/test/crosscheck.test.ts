/**
 * Every layer, over every trace available.
 *
 * The other suites each test one thing well. This one takes all the real traces in the repository —
 * the conformance corpus produced by the adapter, plus the structure fixtures — and pushes each of
 * them through the whole stack: validate, replay, invert, infer, lay out.
 *
 * It exists to catch the failures that only appear at a seam. A trace can be schema-valid and still
 * break the store; state can replay correctly and still produce an inference with no evidence; an
 * inference can be right and still leave an object undrawn. Each of those would pass every focused
 * test and still be a bug the user meets.
 *
 * The properties asserted here are the ones the whole project rests on, so they are stated as such:
 *
 * - a trace always replays, and inverts back to nothing;
 * - both validators agree;
 * - every object gets an inference, and every inference explains itself;
 * - every live data object is drawn somewhere;
 * - the same state always lays out identically.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Trace } from "@flow-view/trace-schema";
import { checkTraceInvariants, validateTrace } from "@flow-view/trace-schema/validate";
import { collectAccess, inferStructures } from "@flow-view/inference";
import { layoutHeap } from "@flow-view/renderers";
import {
  TraceStore,
  captureState,
  compareStates,
  createState,
  describeDifferences,
} from "@flow-view/trace-store";

import { listTraceFiles } from "./traces.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES = [
  { label: "conformance", dir: join(here, "..", ".traces") },
  { label: "structures", dir: join(here, "..", "..", "packages", "inference", "test", "fixtures") },
];

interface Case {
  readonly name: string;
  readonly trace: Trace;
}

function loadAll(): Case[] {
  const cases: Case[] = [];
  for (const source of SOURCES) {
    if (!existsSync(source.dir)) continue;
    for (const file of listTraceFiles(source.dir)) {
      cases.push({
        name: `${source.label}/${file.replace(/\.json$/, "")}`,
        trace: JSON.parse(readFileSync(join(source.dir, file), "utf8")) as Trace,
      });
    }
  }
  return cases;
}

const cases = loadAll();

describe("the corpus", () => {
  it("has traces from both sources", () => {
    // Failing rather than skipping: a verification that quietly finds nothing looks like a pass.
    expect(
      cases.length,
      "no traces found. run: python conformance/runner.py",
    ).toBeGreaterThanOrEqual(30);
    const labels = new Set(cases.map((entry) => entry.name.split("/")[0]));
    expect(labels).toContain("conformance");
    expect(labels).toContain("structures");
  });
});

describe.each(cases.map((entry) => [entry.name, entry.trace] as const))("%s", (name, trace) => {
  it("is valid and coherent", () => {
    const shape = validateTrace(trace);
    expect(shape.valid, `${name}: ${shape.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`)}`).toBe(
      true,
    );
    const coherence = checkTraceInvariants(trace);
    expect(coherence.valid, `${name}: ${coherence.errors.slice(0, 3).map((e) => e.message)}`).toBe(
      true,
    );
  });

  it("replays and inverts exactly", () => {
    const store = new TraceStore();
    store.load(trace);
    store.fastForward();
    store.rewind();
    const diffs = compareStates(store.state, createState());
    expect(diffs.length, `${name} left state behind:\n${describeDifferences(diffs)}`).toBe(0);
  });

  it("reaches the same state from either direction", () => {
    const forward = new TraceStore();
    forward.load(trace);
    const backward = new TraceStore();
    backward.load(trace);
    backward.fastForward();
    const stride = Math.max(1, Math.floor(forward.eventCount / 60));
    for (let position = 0; position <= forward.eventCount; position += stride) {
      forward.seekEvent(position);
      backward.seekEvent(position);
      expect(
        compareStates(forward.state, backward.state).length,
        `${name} diverged at event ${position}`,
      ).toBe(0);
    }
  });

  it("gives every object an inference that explains itself", () => {
    const store = new TraceStore();
    store.load(trace);
    store.fastForward();
    const inference = inferStructures(store.state, { access: collectAccess(store) });

    for (const obj of store.state.objects.values()) {
      if (obj.freed) continue;
      const entry = inference.byObject.get(obj.obj);
      expect(entry, `${name}: ${obj.typeName}#${obj.obj} has no inference`).toBeDefined();
      expect(
        entry!.evidence.length,
        `${name}: ${entry!.shape} for #${obj.obj} claims nothing in support`,
      ).toBeGreaterThan(0);
      for (const line of entry!.evidence) {
        expect(line.trim().length, `${name}: empty evidence line`).toBeGreaterThan(0);
      }
    }
  });

  it("draws every live data object", () => {
    const store = new TraceStore();
    store.load(trace);
    store.fastForward();
    const inference = inferStructures(store.state, { access: collectAccess(store) });
    const layout = layoutHeap({
      state: store.state,
      inferences: inference.byObject,
      language: "python",
    });

    const drawn = new Set(layout.nodes.map((node) => node.obj));
    const missing = [...store.state.objects.values()].filter(
      (obj) =>
        !obj.freed &&
        !["class", "function", "module", "opaque"].includes(obj.kind) &&
        !drawn.has(obj.obj),
    );
    expect(
      missing.map((obj) => `${obj.typeName}#${obj.obj}`),
      `${name} left objects undrawn`,
    ).toEqual([]);
  });

  it("lays out deterministically", () => {
    const place = () => {
      const store = new TraceStore();
      store.load(trace);
      store.fastForward();
      const inference = inferStructures(store.state, { access: collectAccess(store) });
      return layoutHeap({
        state: store.state,
        inferences: inference.byObject,
        language: "python",
      });
    };
    const first = place();
    const second = place();
    expect(second.nodes.map((n) => [n.obj, Math.round(n.x), Math.round(n.y)])).toEqual(
      first.nodes.map((n) => [n.obj, Math.round(n.x), Math.round(n.y)]),
    );
  });

  it("holds its snapshot against replayed state at several points", () => {
    const store = new TraceStore();
    store.load(trace);
    const points = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.floor(store.eventCount * f));
    for (const position of points) {
      store.seekEvent(position);
      const snapshot = captureState(store.state);
      expect(snapshot.frames.length, `${name} at ${position}`).toBe(store.state.frames.size);
      expect(snapshot.objects.length, `${name} at ${position}`).toBe(store.state.objects.size);
    }
  });
});

describe("shared properties across the whole corpus", () => {
  it("no trace produces an inference without a shape", () => {
    for (const { name, trace } of cases) {
      const store = new TraceStore();
      store.load(trace);
      store.fastForward();
      const inference = inferStructures(store.state);
      for (const entry of inference.byObject.values()) {
        expect(entry.shape, `${name}: missing shape`).toBeTruthy();
      }
    }
  });

  it("an override is honoured on every trace that has an object to override", () => {
    let overridden = 0;
    for (const { trace } of cases) {
      const store = new TraceStore();
      store.load(trace);
      store.fastForward();
      const first = [...store.state.objects.values()].find((obj) => !obj.freed);
      if (!first) continue;
      const result = inferStructures(store.state, {
        overrides: new Map([[first.obj, "nary_tree"]]),
      });
      expect(result.byObject.get(first.obj)?.shape).toBe("nary_tree");
      overridden++;
    }
    expect(overridden).toBeGreaterThan(20);
  });

  it("every trace ends in a state that can be rewound and replayed identically", () => {
    for (const { name, trace } of cases) {
      const store = new TraceStore();
      store.load(trace);
      store.fastForward();
      const atEnd = captureState(store.state);
      store.rewind();
      store.fastForward();
      expect(captureState(store.state), `${name} replayed differently the second time`).toEqual(
        atEnd,
      );
    }
  });
});
