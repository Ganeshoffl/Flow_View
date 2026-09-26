/**
 * Capturing and comparing program state.
 *
 * Two uses, both essential rather than incidental.
 *
 * `captureState` produces the `StateSnapshot` the schema defines, which is how a trace carries
 * seek accelerators and how the conformance suite checks that an adapter's own snapshots agree
 * with state derived by pure replay.
 *
 * `compareStates` is how the invertibility guarantee is actually tested: replay a trace to the end,
 * invert all the way back, and assert the result is indistinguishable from where it started. A
 * structural comparison with a readable explanation of the first difference is the difference
 * between a test that catches a bug and a test that says "false is not true".
 */

import type { StateSnapshot, Value } from "@flow-view/trace-schema";
import { valueEquals } from "@flow-view/trace-schema";

import type { FrameLive, ObjectLive, TraceState } from "./state.js";

/** Capture complete state as a schema `StateSnapshot`. */
export function captureState(state: TraceState): StateSnapshot {
  const frames = [...state.frames.values()].map((frame) => ({
    frame: frame.frame,
    func: frame.func,
    path: frame.path,
    line: frame.line,
    kind: frame.kind,
    ...(frame.caller === undefined ? {} : { caller: frame.caller }),
    recursion_depth: frame.recursionDepth,
    bindings: Object.fromEntries(frame.bindings),
    scopes: Object.fromEntries(frame.scopes),
  }));

  const objects = [...state.objects.values()].map((obj) => ({
    obj: obj.obj,
    kind: obj.kind,
    type_name: obj.typeName,
    slots: Object.fromEntries(obj.slots),
    order: [...obj.order],
    ...(obj.length === undefined ? {} : { length: obj.length }),
    ...(obj.addr === undefined ? {} : { addr: obj.addr }),
    ...(obj.shape === undefined ? {} : { shape: obj.shape }),
    ...(obj.summary === undefined ? {} : { summary: obj.summary }),
  }));

  const loops = [...state.loops.values()]
    .filter((loop) => loop.active)
    .map((loop) => ({
      region: loop.region,
      line_start: loop.lineStart,
      line_end: loop.lineEnd,
      iteration: loop.iteration,
    }));

  return {
    full: true,
    frames,
    frame_order: [...state.frameOrder],
    objects,
    ...(loops.length ? { loops } : {}),
    ...(state.metrics.size ? { metrics: Object.fromEntries(state.metrics) } : {}),
  };
}

/** A single structural difference between two states. */
export interface StateDifference {
  readonly path: string;
  readonly left: string;
  readonly right: string;
}

const show = (v: unknown): string => {
  if (v === undefined) return "absent";
  return JSON.stringify(v) ?? String(v);
};

function compareValueMaps(
  path: string,
  left: Map<string, Value>,
  right: Map<string, Value>,
  out: StateDifference[],
): void {
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined) {
      out.push({ path: `${path}.${key}`, left: show(value), right: "absent" });
    } else if (!valueEquals(value, other)) {
      out.push({ path: `${path}.${key}`, left: show(value), right: show(other) });
    }
  }
  for (const key of right.keys()) {
    if (!left.has(key)) {
      out.push({ path: `${path}.${key}`, left: "absent", right: show(right.get(key)) });
    }
  }
}

function compareFrames(a: FrameLive, b: FrameLive, out: StateDifference[]): void {
  const p = `frame[${a.frame}]`;
  const scalars: [string, unknown, unknown][] = [
    ["func", a.func, b.func],
    ["path", a.path, b.path],
    ["line", a.line, b.line],
    ["active", a.active, b.active],
    ["recursionDepth", a.recursionDepth, b.recursionDepth],
    ["poppedAtStep", a.poppedAtStep, b.poppedAtStep],
  ];
  for (const [name, left, right] of scalars) {
    if (left !== right) out.push({ path: `${p}.${name}`, left: show(left), right: show(right) });
  }
  if (!valueEquals(a.returnValue, b.returnValue)) {
    out.push({ path: `${p}.returnValue`, left: show(a.returnValue), right: show(b.returnValue) });
  }
  compareValueMaps(`${p}.bindings`, a.bindings, b.bindings, out);
}

function compareObjects(a: ObjectLive, b: ObjectLive, out: StateDifference[]): void {
  const p = `object[${a.obj}]`;
  const scalars: [string, unknown, unknown][] = [
    ["kind", a.kind, b.kind],
    ["typeName", a.typeName, b.typeName],
    ["length", a.length, b.length],
    ["freed", a.freed, b.freed],
    ["shape", a.shape, b.shape],
    ["shapeConfidence", a.shapeConfidence, b.shapeConfidence],
  ];
  for (const [name, left, right] of scalars) {
    if (left !== right) out.push({ path: `${p}.${name}`, left: show(left), right: show(right) });
  }
  if (a.order.join(",") !== b.order.join(",")) {
    out.push({ path: `${p}.order`, left: show(a.order), right: show(b.order) });
  }
  compareValueMaps(`${p}.slots`, a.slots, b.slots, out);
}

/**
 * Every structural difference between two states.
 *
 * Empty means indistinguishable. `version` is excluded on purpose: it counts mutations, and after
 * a round trip forward and back it is expected to differ while the state it describes does not.
 */
export function compareStates(left: TraceState, right: TraceState): StateDifference[] {
  const out: StateDifference[] = [];

  const scalars: [string, unknown, unknown][] = [
    ["seq", left.seq, right.seq],
    ["step", left.step, right.step],
    ["ms", left.ms, right.ms],
    ["status", left.status, right.status],
    ["exitCode", left.exitCode, right.exitCode],
    ["frameOrder", left.frameOrder.join(","), right.frameOrder.join(",")],
    ["lastPoppedFrame", left.lastPoppedFrame, right.lastPoppedFrame],
    ["output.length", left.output.length, right.output.length],
    ["notes.length", left.notes.length, right.notes.length],
    ["exceptions.length", left.exceptions.length, right.exceptions.length],
    ["pendingInput", JSON.stringify(left.pendingInput), JSON.stringify(right.pendingInput)],
  ];
  for (const [name, a, b] of scalars) {
    if (a !== b) out.push({ path: name, left: show(a), right: show(b) });
  }

  for (const [id, frame] of left.frames) {
    const other = right.frames.get(id);
    if (!other) out.push({ path: `frame[${id}]`, left: "present", right: "absent" });
    else compareFrames(frame, other, out);
  }
  for (const id of right.frames.keys()) {
    if (!left.frames.has(id)) {
      out.push({ path: `frame[${id}]`, left: "absent", right: "present" });
    }
  }

  for (const [id, obj] of left.objects) {
    const other = right.objects.get(id);
    if (!other) out.push({ path: `object[${id}]`, left: "present", right: "absent" });
    else compareObjects(obj, other, out);
  }
  for (const id of right.objects.keys()) {
    if (!left.objects.has(id)) {
      out.push({ path: `object[${id}]`, left: "absent", right: "present" });
    }
  }

  for (const [name, total] of left.metrics) {
    const other = right.metrics.get(name);
    if (total !== other) {
      out.push({ path: `metric.${name}`, left: show(total), right: show(other) });
    }
  }
  for (const name of right.metrics.keys()) {
    if (!left.metrics.has(name)) {
      out.push({ path: `metric.${name}`, left: "absent", right: show(right.metrics.get(name)) });
    }
  }

  for (const [i, chunk] of left.output.entries()) {
    const other = right.output[i];
    if (!other || other.text !== chunk.text || other.stream !== chunk.stream) {
      out.push({ path: `output[${i}]`, left: show(chunk.text), right: show(other?.text) });
    }
  }

  return out;
}

/** Render differences for a test failure message. */
export function describeDifferences(diffs: readonly StateDifference[], limit = 8): string {
  if (diffs.length === 0) return "states are identical";
  const shown = diffs
    .slice(0, limit)
    .map((d) => `  ${d.path}: ${d.left} != ${d.right}`)
    .join("\n");
  const more = diffs.length > limit ? `\n  …and ${diffs.length - limit} more` : "";
  return `${diffs.length} difference(s):\n${shown}${more}`;
}
