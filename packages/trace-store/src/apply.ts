/**
 * Forward and backward application of trace events.
 *
 * This is the only place in flow_view where trace semantics live. The fixture builder, the
 * TraceStore, the conformance suite and every renderer derive their notion of "what this event
 * means" from here, so a disagreement about semantics is impossible by construction.
 *
 * ## The undo journal
 *
 * Most events are self-inverting: `var_set` carries `prev`, so undoing it is writing `prev` back.
 * A few touch state the event does not describe — `step_line` moves a frame's current line without
 * saying where it came from, and an `insert` into a list renumbers every position after it.
 *
 * The alternative would be putting that information in the trace: a `prev_line` on every single
 * step event, a full order array on every insert. On a million-step trace that is a large, constant
 * tax paid by every consumer, to serve backward stepping alone.
 *
 * So `applyEvent` returns a small **undo record** capturing exactly what the event did not say, and
 * `revertEvent` consumes it. The journal is local bookkeeping held beside the trace, never part of
 * it — the trace stays small, and inversion stays exact.
 *
 * An event may do several things at once (a `frame_pop` both moves a cursor and closes a frame), so
 * a record holds an ordered list of details and inverts them in reverse.
 */

import {
  type MetricName,
  type TraceEvent,
  type Value,
  type VarScope,
  isEvent,
} from "@flow-view/trace-schema";

import type { FrameLive, ObjectLive, TraceState } from "./state.js";

/** One thing an event changed that it did not itself record. */
export type UndoDetail =
  | { k: "line"; frame: number; line: number; path: string }
  | { k: "framePush"; frame: number }
  | {
      k: "framePop";
      /** Where in the open-frame order it sat, so undoing puts it back there. */
      orderIndex: number;
      frame: number;
      returnValue: Value | undefined;
      poppedAtStep: number | undefined;
      poppedAtMs: number | undefined;
      prevLastPopped: number | undefined;
    }
  | {
      k: "objOrder";
      obj: number;
      order: string[];
      slots: [string, Value][];
      length: number | undefined;
    }
  | { k: "objNew"; obj: number }
  | { k: "objFreed"; obj: number; freed: boolean }
  | { k: "varSet"; frame: number; name: string; had: boolean; prevScope: VarScope | undefined }
  | { k: "varDel"; frame: number; name: string; prevScope: VarScope | undefined }
  | {
      k: "shape";
      obj: number;
      shape: ObjectLive["shape"];
      confidence: ObjectLive["shapeConfidence"];
      evidence: ObjectLive["shapeEvidence"];
    }
  | { k: "loopEnter"; region: number; existed: boolean }
  | { k: "loopIter"; region: number; iteration: number }
  | { k: "loopExit"; region: number; active: boolean; iterations: number | undefined }
  | { k: "output" }
  | { k: "note" }
  | { k: "pendingInput"; prev: TraceState["pendingInput"] }
  | { k: "exceptionPush" }
  | { k: "exceptionCatch"; index: number; caught: boolean }
  | { k: "runEnd"; status: TraceState["status"]; exitCode: number | undefined }
  | { k: "metric"; name: MetricName; delta: number }
  | { k: "collapse" };

/** Playhead position plus everything the event did not record. */
export interface UndoRecord {
  readonly seq: number;
  readonly step: number;
  readonly ms: number;
  /** Applied in order going forward; reverted in reverse. */
  readonly details: readonly UndoDetail[];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function requireObject(state: TraceState, id: number, what: string): ObjectLive {
  const obj = state.objects.get(id);
  if (!obj) throw new Error(`${what}: object ${id} is not in state`);
  return obj;
}

function requireFrame(state: TraceState, id: number | undefined, what: string): FrameLive {
  const frame = id === undefined ? undefined : state.frames.get(id);
  if (!frame) throw new Error(`${what}: frame ${String(id)} is not in state`);
  return frame;
}

/** Copy the parts of an object that a reordering mutation destroys. */
function captureOrder(obj: ObjectLive): UndoDetail {
  return {
    k: "objOrder",
    obj: obj.obj,
    order: [...obj.order],
    slots: [...obj.slots.entries()],
    length: obj.length,
  };
}

/**
 * Renumber positional slot keys after an insert or delete.
 *
 * Sequences use positions as slot keys, so an insert shifts every key after it. The alternative —
 * opaque stable slot ids — would preserve element identity across shifts, which matters only for
 * animation polish; it can be added later as an optional field without a breaking change. Positions
 * are what adapters naturally observe (`lst.insert(2, x)`), and unambiguous is worth more here.
 */
function renumber(obj: ObjectLive): void {
  const values = obj.order.map((key) => obj.slots.get(key));
  obj.slots.clear();
  obj.order = values.map((value, i) => {
    const key = String(i);
    if (value !== undefined) obj.slots.set(key, value);
    return key;
  });
  obj.length = obj.order.length;
}

type CollapseEffectLike = {
  kind: string;
  frame?: number;
  obj?: number;
  key: string;
  before?: Value;
  after?: Value;
};

function writeEffect(state: TraceState, effect: CollapseEffectLike, side: "before" | "after"): void {
  const value = side === "after" ? effect.after : effect.before;
  if (effect.kind === "var" && effect.frame !== undefined) {
    const frame = state.frames.get(effect.frame);
    if (!frame) return;
    if (value === undefined) frame.bindings.delete(effect.key);
    else frame.bindings.set(effect.key, value);
    return;
  }
  if (effect.kind === "obj" && effect.obj !== undefined) {
    const obj = state.objects.get(effect.obj);
    if (!obj) return;
    if (value === undefined) {
      obj.slots.delete(effect.key);
      const idx = obj.order.indexOf(effect.key);
      if (idx >= 0) obj.order.splice(idx, 1);
    } else {
      if (!obj.slots.has(effect.key)) obj.order.push(effect.key);
      obj.slots.set(effect.key, value);
    }
  }
}

function addMetric(state: TraceState, name: MetricName, delta: number): void {
  const next = (state.metrics.get(name) ?? 0) + delta;
  if (next === 0) state.metrics.delete(name);
  else state.metrics.set(name, next);
}

// ---------------------------------------------------------------------------
// forward
// ---------------------------------------------------------------------------

/**
 * Apply one event, mutating state, and return what is needed to undo it.
 *
 * `snapshot` events are deliberately inert. They exist to accelerate seeking, and their content is
 * by definition redundant with replaying the events around them — applying one during sequential
 * playback would be doing the same work twice.
 */
export function applyEvent(state: TraceState, event: TraceEvent): UndoRecord {
  const details: UndoDetail[] = [];

  // Any event carrying a line moves its frame's cursor, not only step_line: a call, a branch and
  // a raise all say where execution now is. frame_push is excluded because it establishes a new
  // frame's initial line rather than moving an existing cursor.
  if (event.line !== undefined && event.frame !== undefined && event.t !== "frame_push") {
    const frame = state.frames.get(event.frame);
    if (frame) {
      details.push({ k: "line", frame: frame.frame, line: frame.line, path: frame.path });
      frame.line = event.line;
      if (event.path !== undefined) frame.path = event.path;
    }
  }

  applyCore(state, event, details);

  const undo: UndoRecord = { seq: state.seq, step: state.step, ms: state.ms, details };

  state.seq = event.seq;
  if (event.step !== undefined) state.step = event.step;
  if (event.ms !== undefined) state.ms = event.ms;
  state.version++;
  return undo;
}

function applyCore(state: TraceState, event: TraceEvent, out: UndoDetail[]): void {
  switch (event.t) {
    case "run_start":
    case "step_line":
    case "branch":
    case "jump":
    case "exception_uncaught":
      return;

    // Native memory is presented directly from events by the memory view; it needs no live model
    // beyond the objects already tracked here.
    case "mem_alloc":
    case "mem_free":
    case "ptr_set":
      return;

    // Inert by design. See the note on applyEvent.
    case "snapshot":
      return;

    case "run_end":
      out.push({ k: "runEnd", status: state.status, exitCode: state.exitCode });
      state.status = event.status;
      state.exitCode = event.exit_code;
      return;

    case "loop_enter":
      out.push({ k: "loopEnter", region: event.region, existed: state.loops.has(event.region) });
      state.loops.set(event.region, {
        region: event.region,
        lineStart: event.line_start,
        lineEnd: event.line_end,
        iteration: 0,
        active: true,
        iterations: undefined,
      });
      return;

    case "loop_iter": {
      const loop = state.loops.get(event.region);
      if (!loop) return;
      out.push({ k: "loopIter", region: event.region, iteration: loop.iteration });
      loop.iteration = event.i;
      return;
    }

    case "loop_exit": {
      const loop = state.loops.get(event.region);
      if (!loop) return;
      out.push({
        k: "loopExit",
        region: event.region,
        active: loop.active,
        iterations: loop.iterations,
      });
      loop.active = false;
      loop.iterations = event.iterations;
      return;
    }

    case "frame_push": {
      const id = event.frame;
      if (id === undefined) throw new Error("frame_push without a frame id");
      if (state.frames.has(id)) {
        throw new Error(`frame_push: frame ${id} already exists; ids must be unique per run`);
      }
      state.frames.set(id, {
        frame: id,
        func: event.func,
        path: event.path ?? "",
        line: event.line ?? 0,
        kind: event.kind,
        caller: event.caller,
        recursionDepth: event.recursion_depth,
        args: event.args.map((a) => ({ name: a.name, value: a.value })),
        bindings: new Map(event.args.map((a) => [a.name, a.value])),
        scopes: new Map(event.args.map((a) => [a.name, "param" as VarScope])),
        active: true,
        returnValue: undefined,
        pushedAtStep: event.step ?? state.step,
        poppedAtStep: undefined,
        pushedAtMs: event.ms,
        poppedAtMs: undefined,
      });
      state.frameOrder.push(id);
      out.push({ k: "framePush", frame: id });
      return;
    }

    case "frame_pop": {
      const frame = requireFrame(state, event.frame, "frame_pop");
      // Removed by identity, not from the end.
      //
      // This used to insist the frame being closed was the innermost one, and threw otherwise. That holds for a
      // program doing one thing at a time and fails for any program that does not: two `async` calls both have
      // open frames, and the one that finishes first closes first whichever was opened first. The store refused
      // to replay such a trace at all.
      //
      // The position is recorded so the undo can put it back where it was, which is what keeps stepping backwards
      // exact rather than approximately right.
      const at = state.frameOrder.lastIndexOf(frame.frame);
      if (at < 0) {
        throw new Error(`frame_pop: ${frame.frame} was not open`);
      }
      out.push({
        k: "framePop",
        frame: frame.frame,
        orderIndex: at,
        returnValue: frame.returnValue,
        poppedAtStep: frame.poppedAtStep,
        poppedAtMs: frame.poppedAtMs,
        prevLastPopped: state.lastPoppedFrame,
      });
      frame.active = false;
      frame.returnValue = event.return_value;
      frame.poppedAtStep = event.step ?? state.step;
      frame.poppedAtMs = event.ms;
      state.frameOrder.splice(at, 1);
      state.lastPoppedFrame = frame.frame;
      return;
    }

    case "var_set": {
      const frame = requireFrame(state, event.frame, "var_set");
      out.push({
        k: "varSet",
        frame: frame.frame,
        name: event.name,
        had: frame.bindings.has(event.name),
        prevScope: frame.scopes.get(event.name),
      });
      frame.bindings.set(event.name, event.value);
      frame.scopes.set(event.name, event.scope);
      return;
    }

    case "var_del": {
      const frame = requireFrame(state, event.frame, "var_del");
      out.push({
        k: "varDel",
        frame: frame.frame,
        name: event.name,
        prevScope: frame.scopes.get(event.name),
      });
      frame.bindings.delete(event.name);
      frame.scopes.delete(event.name);
      return;
    }

    case "obj_new": {
      if (state.objects.has(event.obj)) {
        throw new Error(`obj_new: object ${event.obj} already exists`);
      }
      state.objects.set(event.obj, {
        obj: event.obj,
        kind: event.kind,
        typeName: event.type_name,
        slots: new Map(),
        order: [],
        length: event.length,
        addr: event.addr,
        summary: event.summary,
        shape: undefined,
        shapeConfidence: undefined,
        shapeEvidence: undefined,
        shapeOverride: undefined,
        freed: false,
        createdAtStep: event.step ?? state.step,
      });
      out.push({ k: "objNew", obj: event.obj });
      return;
    }

    case "obj_set": {
      const obj = requireObject(state, event.obj, "obj_set");
      const key = String(event.key);
      out.push(captureOrder(obj));
      switch (event.op) {
        case "set":
          if (!obj.slots.has(key)) obj.order.push(key);
          obj.slots.set(key, event.value);
          if (obj.length !== undefined) obj.length = Math.max(obj.length, obj.order.length);
          return;
        case "append":
          obj.order.push(key);
          obj.slots.set(key, event.value);
          obj.length = obj.order.length;
          return;
        case "insert": {
          const at = Number.isNaN(Number(key)) ? obj.order.length : Number(key);
          const placeholder = "\u0000inserted";
          obj.order.splice(at, 0, placeholder);
          obj.slots.set(placeholder, event.value);
          renumber(obj);
          return;
        }
        case "delete": {
          const idx = obj.order.indexOf(key);
          if (idx < 0) return;
          obj.order.splice(idx, 1);
          obj.slots.delete(key);
          // Positional containers renumber; keyed ones keep their remaining keys.
          if (/^\d+$/.test(key)) renumber(obj);
          else obj.length = obj.order.length;
          return;
        }
      }
      return;
    }

    case "obj_resize": {
      const obj = requireObject(state, event.obj, "obj_resize");
      out.push(captureOrder(obj));
      const cleared = event.cleared ?? [];
      for (const key of cleared) {
        const idx = obj.order.indexOf(key);
        if (idx >= 0) obj.order.splice(idx, 1);
        obj.slots.delete(key);
      }
      // A shrink that did not name its casualties: drop the tail to match the new length.
      if (cleared.length === 0 && event.length < obj.order.length) {
        for (const key of obj.order.slice(event.length)) obj.slots.delete(key);
        obj.order = obj.order.slice(0, event.length);
      }
      obj.length = event.length;
      return;
    }

    case "obj_free": {
      const obj = requireObject(state, event.obj, "obj_free");
      out.push({ k: "objFreed", obj: obj.obj, freed: obj.freed });
      obj.freed = true;
      return;
    }

    case "stdout":
    case "stderr":
      state.output.push({ stream: event.t, text: event.text, step: state.step, seq: event.seq });
      out.push({ k: "output" });
      return;

    case "stdin_request":
      out.push({ k: "pendingInput", prev: state.pendingInput });
      state.pendingInput = { prompt: event.prompt, seq: event.seq };
      return;

    case "stdin_response":
      out.push({ k: "pendingInput", prev: state.pendingInput });
      state.pendingInput = undefined;
      return;

    case "exception_raise":
      state.exceptions.push({
        type: event.type,
        message: event.message,
        frame: event.frame,
        obj: event.obj,
        caught: false,
        seq: event.seq,
      });
      out.push({ k: "exceptionPush" });
      return;

    case "exception_catch": {
      const index = state.exceptions.length - 1;
      const exc = state.exceptions[index];
      if (!exc) return;
      out.push({ k: "exceptionCatch", index, caught: exc.caught });
      exc.caught = true;
      return;
    }

    case "metric":
      addMetric(state, event.name, event.delta);
      out.push({ k: "metric", name: event.name, delta: event.delta });
      return;

    case "structure_hint": {
      const obj = state.objects.get(event.obj);
      if (!obj) return;
      out.push({
        k: "shape",
        obj: obj.obj,
        shape: obj.shape,
        confidence: obj.shapeConfidence,
        evidence: obj.shapeEvidence,
      });
      obj.shape = event.shape;
      obj.shapeConfidence = event.confidence;
      obj.shapeEvidence = event.evidence;
      return;
    }

    case "collapse":
      for (const effect of event.effects) writeEffect(state, effect, "after");
      if (event.metrics) {
        for (const [name, delta] of Object.entries(event.metrics)) {
          addMetric(state, name as MetricName, delta);
        }
      }
      out.push({ k: "collapse" });
      return;

    case "note":
      state.notes.push({ level: event.level, text: event.text, seq: event.seq });
      out.push({ k: "note" });
      return;

    default:
      // Forward compatibility: an unknown event type within the same major version is ignored,
      // never an error. See the versioning rules in trace-schema.md.
      return;
  }
}

// ---------------------------------------------------------------------------
// backward
// ---------------------------------------------------------------------------

/** Undo one event, restoring the state that preceded it. */
export function revertEvent(state: TraceState, event: TraceEvent, undo: UndoRecord): void {
  for (let i = undo.details.length - 1; i >= 0; i--) {
    const detail = undo.details[i];
    if (detail) revertDetail(state, event, detail);
  }
  state.seq = undo.seq;
  state.step = undo.step;
  state.ms = undo.ms;
  state.version++;
}

function revertDetail(state: TraceState, event: TraceEvent, detail: UndoDetail): void {
  switch (detail.k) {
    case "line": {
      const frame = state.frames.get(detail.frame);
      if (frame) {
        frame.line = detail.line;
        frame.path = detail.path;
      }
      return;
    }

    case "runEnd":
      state.status = detail.status;
      state.exitCode = detail.exitCode;
      return;

    case "framePush":
      state.frames.delete(detail.frame);
      if (state.frameOrder[state.frameOrder.length - 1] === detail.frame) state.frameOrder.pop();
      return;

    case "framePop": {
      const frame = state.frames.get(detail.frame);
      if (!frame) return;
      frame.active = true;
      frame.returnValue = detail.returnValue;
      frame.poppedAtStep = detail.poppedAtStep;
      frame.poppedAtMs = detail.poppedAtMs;
      // Back where it was, not on the end. With concurrent calls the frame that closed may have been in the
      // middle, and putting it back on top would reorder the stack every time someone stepped backwards.
      state.frameOrder.splice(detail.orderIndex, 0, detail.frame);
      state.lastPoppedFrame = detail.prevLastPopped;
      return;
    }

    case "varSet": {
      const frame = state.frames.get(detail.frame);
      if (!frame) return;
      const prev = isEvent(event, "var_set") ? event.prev : undefined;
      if (detail.had && prev !== undefined) frame.bindings.set(detail.name, prev);
      else frame.bindings.delete(detail.name);
      if (detail.prevScope === undefined) frame.scopes.delete(detail.name);
      else frame.scopes.set(detail.name, detail.prevScope);
      return;
    }

    case "varDel": {
      const frame = state.frames.get(detail.frame);
      if (!frame || !isEvent(event, "var_del")) return;
      frame.bindings.set(detail.name, event.prev);
      if (detail.prevScope !== undefined) frame.scopes.set(detail.name, detail.prevScope);
      return;
    }

    case "objNew":
      state.objects.delete(detail.obj);
      return;

    case "objOrder": {
      const obj = state.objects.get(detail.obj);
      if (!obj) return;
      obj.order = [...detail.order];
      obj.slots.clear();
      for (const [k, v] of detail.slots) obj.slots.set(k, v);
      obj.length = detail.length;
      return;
    }

    case "objFreed": {
      const obj = state.objects.get(detail.obj);
      if (obj) obj.freed = detail.freed;
      return;
    }

    case "shape": {
      const obj = state.objects.get(detail.obj);
      if (!obj) return;
      obj.shape = detail.shape;
      obj.shapeConfidence = detail.confidence;
      obj.shapeEvidence = detail.evidence;
      return;
    }

    case "loopEnter":
      if (!detail.existed) state.loops.delete(detail.region);
      return;

    case "loopIter": {
      const loop = state.loops.get(detail.region);
      if (loop) loop.iteration = detail.iteration;
      return;
    }

    case "loopExit": {
      const loop = state.loops.get(detail.region);
      if (loop) {
        loop.active = detail.active;
        loop.iterations = detail.iterations;
      }
      return;
    }

    case "output":
      state.output.pop();
      return;

    case "note":
      state.notes.pop();
      return;

    case "pendingInput":
      state.pendingInput = detail.prev;
      return;

    case "exceptionPush":
      state.exceptions.pop();
      return;

    case "exceptionCatch": {
      const exc = state.exceptions[detail.index];
      if (exc) exc.caught = detail.caught;
      return;
    }

    case "metric":
      addMetric(state, detail.name, -detail.delta);
      return;

    case "collapse": {
      if (!isEvent(event, "collapse")) return;
      for (const effect of event.effects) writeEffect(state, effect, "before");
      if (event.metrics) {
        for (const [name, delta] of Object.entries(event.metrics)) {
          addMetric(state, name as MetricName, -delta);
        }
      }
      return;
    }
  }
}
