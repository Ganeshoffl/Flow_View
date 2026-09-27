/**
 * Live program state reconstructed from a trace.
 *
 * Two decisions shape this module.
 *
 * **State is mutated in place, not copied.** Playback is overwhelmingly sequential — one step
 * forward or back — and cloning a ten-thousand-object heap on every step would be the single
 * worst performance decision available. Instead, state carries a `version` counter that React
 * subscribes to, and changes are applied destructively by `applyEvent` / `revertEvent`.
 *
 * **Nothing is ever deleted.** Popped frames and freed objects are flagged, not removed. That is
 * what makes `frame_pop` and `obj_free` invertible without the trace having to carry a copy of
 * everything they destroyed — and it is also what lets the timeline view inspect a call that has
 * already returned.
 */

import type {
  Confidence,
  FrameKind,
  MetricName,
  ObjKind,
  RunStatus,
  Shape,
  Value,
  VarScope,
} from "@flow-view/trace-schema";

/** A call frame. Retained after it returns, flagged inactive. */
export interface FrameLive {
  readonly frame: number;
  readonly func: string;
  path: string;
  line: number;
  readonly kind: FrameKind;
  readonly caller: number | undefined;
  readonly recursionDepth: number;
  readonly args: readonly { name: string; value: Value }[];
  /** Variable name to current value. */
  readonly bindings: Map<string, Value>;
  /** Variable name to declaring scope. */
  readonly scopes: Map<string, VarScope>;
  /** False once the frame has returned. */
  active: boolean;
  returnValue: Value | undefined;
  /** Step at which the frame was pushed, for the timeline. */
  readonly pushedAtStep: number;
  /** Step at which it returned, if it has. */
  poppedAtStep: number | undefined;
  /** Milliseconds since run start when pushed. */
  readonly pushedAtMs: number | undefined;
  poppedAtMs: number | undefined;
}

/** A heap object. Retained after it is freed, flagged. */
export interface ObjectLive {
  readonly obj: number;
  readonly kind: ObjKind;
  readonly typeName: string;
  /**
   * Slot key to value. For sequences the keys are positional decimal strings, renumbered on
   * insert and delete; `order` gives the display sequence.
   */
  readonly slots: Map<string, Value>;
  /** Display order of slot keys. */
  order: string[];
  length: number | undefined;
  readonly addr: string | undefined;
  summary: string | undefined;
  /** Inferred shape, most recent hint. */
  shape: Shape | undefined;
  shapeConfidence: Confidence | undefined;
  shapeEvidence: readonly string[] | undefined;
  /** User correction. Always wins over inference. */
  shapeOverride: Shape | undefined;
  /** True after explicit deallocation (C/C++). */
  freed: boolean;
  readonly createdAtStep: number;
}

/** An active loop region. */
export interface LoopLive {
  readonly region: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  iteration: number;
  active: boolean;
  iterations: number | undefined;
}

/** One chunk of program output, tied to the step that produced it. */
export interface OutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly step: number;
  readonly seq: number;
}

/** An in-flight exception. */
export interface ExceptionLive {
  readonly type: string;
  readonly message: string;
  readonly frame: number | undefined;
  readonly obj: number | undefined;
  caught: boolean;
  readonly seq: number;
}

/** A pending request for standard input. */
export interface PendingInput {
  readonly prompt: string | undefined;
  readonly seq: number;
}

export interface TraceState {
  /** Bumped on every mutation, so subscribers can detect change cheaply. */
  version: number;
  /** Seq of the most recently applied event, or -1 before anything is applied. */
  seq: number;
  /** Step ordinal of the playhead, or -1 before the first steppable event. */
  step: number;
  /** Wall-clock position, milliseconds since run start. */
  ms: number;

  readonly frames: Map<number, FrameLive>;
  /** Active frame ids, outermost first. */
  frameOrder: number[];
  /**
   * Most recently returned frame.
   *
   * Once a program finishes, no frame is active. Showing an empty stack and an empty variables
   * panel at that moment would hide the very values the user just watched being computed, so the
   * views fall back to this frame. Tracked incrementally rather than searched for, because a
   * hundred-thousand-call run must not pay a scan on every render.
   */
  lastPoppedFrame: number | undefined;
  readonly objects: Map<number, ObjectLive>;
  readonly loops: Map<number, LoopLive>;
  readonly metrics: Map<MetricName, number>;
  readonly output: OutputChunk[];
  /** Exception stack; the last entry is the innermost in-flight exception. */
  readonly exceptions: ExceptionLive[];
  pendingInput: PendingInput | undefined;
  /** Set once `run_end` is applied. */
  status: RunStatus | undefined;
  exitCode: number | undefined;
  /** Adapter diagnostics, in order. */
  readonly notes: { level: "info" | "warn"; text: string; seq: number }[];
}

export function createState(): TraceState {
  return {
    version: 0,
    seq: -1,
    step: -1,
    ms: 0,
    frames: new Map(),
    frameOrder: [],
    lastPoppedFrame: undefined,
    objects: new Map(),
    loops: new Map(),
    metrics: new Map(),
    output: [],
    exceptions: [],
    pendingInput: undefined,
    status: undefined,
    exitCode: undefined,
    notes: [],
  };
}

/** Reset state in place, keeping identity so subscribers stay attached. */
export function resetState(state: TraceState): void {
  state.seq = -1;
  state.step = -1;
  state.ms = 0;
  state.frames.clear();
  state.frameOrder = [];
  state.lastPoppedFrame = undefined;
  state.objects.clear();
  state.loops.clear();
  state.metrics.clear();
  state.output.length = 0;
  state.exceptions.length = 0;
  state.pendingInput = undefined;
  state.status = undefined;
  state.exitCode = undefined;
  state.notes.length = 0;
  state.version++;
}

/**
 * A detached copy of the whole state, for use as a seek keyframe.
 *
 * Deliberately structural rather than a hand-written field list. `restoreState` below walks whatever
 * keys exist, so a field added to `TraceState` later is copied without anyone remembering to come back
 * here — and a field silently missed is exactly the bug that would make a seek land in a state that
 * looks plausible and is wrong.
 */
export function snapshotState(state: TraceState): TraceState {
  return structuredClone(state) as TraceState;
}

/**
 * Overwrite `target` with the contents of `source`, in place.
 *
 * In place because `TraceStore.state` is a stable reference that every pane holds. Replacing the object
 * would leave the UI reading a state the store had stopped updating.
 *
 * Everything is cloned on the way out, so a keyframe can be restored any number of times without the
 * live state ever sharing structure with it. Sharing would mean the next mutation quietly corrupted the
 * keyframe, and the seek after that would land somewhere that never existed.
 */
export function restoreState(target: TraceState, source: TraceState): void {
  const sink = target as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(source as unknown as Record<string, unknown>)) {
    const current = sink[key];
    if (value instanceof Map && current instanceof Map) {
      current.clear();
      for (const [k, v] of value) current.set(k, structuredClone(v));
    } else if (Array.isArray(value) && Array.isArray(current)) {
      current.length = 0;
      for (const item of value) current.push(structuredClone(item));
    } else {
      sink[key] = structuredClone(value);
    }
  }
  target.version++;
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/** Innermost active frame, or undefined when nothing is executing. */
export function currentFrame(state: TraceState): FrameLive | undefined {
  const id = state.frameOrder[state.frameOrder.length - 1];
  return id === undefined ? undefined : state.frames.get(id);
}

/**
 * The frame the views should describe: the innermost active one, or the last to return.
 *
 * Use this for anything the user reads — variables, the highlighted line, narration. Use
 * `currentFrame` only when the question is genuinely about what is executing right now, such as
 * measuring stack depth for step-over.
 */
export function focusFrame(state: TraceState): FrameLive | undefined {
  return (
    currentFrame(state) ??
    (state.lastPoppedFrame === undefined ? undefined : state.frames.get(state.lastPoppedFrame))
  );
}

/** Active frames, innermost first — the order the stack view renders. */
export function activeFrames(state: TraceState): FrameLive[] {
  const out: FrameLive[] = [];
  for (let i = state.frameOrder.length - 1; i >= 0; i--) {
    const id = state.frameOrder[i];
    const frame = id === undefined ? undefined : state.frames.get(id);
    if (frame) out.push(frame);
  }
  return out;
}

/** Shape to render an object as: user override first, then inference. */
export function effectiveShape(obj: ObjectLive): Shape | undefined {
  return obj.shapeOverride ?? obj.shape;
}

/** Ordered slot entries of an object. */
export function slotEntries(obj: ObjectLive): { key: string; value: Value }[] {
  return obj.order.flatMap((key) => {
    const value = obj.slots.get(key);
    return value === undefined ? [] : [{ key, value }];
  });
}

/** Current source line and file, for the code view. */
export function currentLocation(state: TraceState): { path: string; line: number } | undefined {
  const frame = focusFrame(state);
  return frame ? { path: frame.path, line: frame.line } : undefined;
}
