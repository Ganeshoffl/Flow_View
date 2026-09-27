/**
 * The TraceStore: a trace plus a playhead.
 *
 * Playback is entirely local to this class. Stepping, back-stepping and seeking never contact the
 * adapter that produced the trace and never re-execute the program — they replay recorded history.
 * That is what makes backward stepping instant, and what makes it safe for a program with side
 * effects: nothing runs twice.
 *
 * The store is framework-free by design. React binds to it through `subscribe` and the `version`
 * counter on state; nothing here imports a UI library, so the same store runs in tests, in Node,
 * in a Web Worker and in the browser.
 */

import {
  STEPPABLE_EVENT_TYPES,
  type EventType,
  type Session,
  type Trace,
  type TraceEvent,
  type Value,
  assertSupportedSchema,
  valueEquals,
} from "@flow-view/trace-schema";

import { type UndoRecord, applyEvent, revertEvent } from "./apply.js";
import {
  type TraceState,
  createState,
  focusFrame,
  resetState,
  restoreState,
  snapshotState,
} from "./state.js";

/**
 * Events between seek keyframes.
 *
 * Small enough that walking from one costs a fraction of a frame, large enough that a short trace never
 * pays for a copy it will not use. Doubles as the trace grows; see `maybeCapture`.
 */
const KEYFRAME_INTERVAL = 2000;

/**
 * How many keyframes to keep.
 *
 * Each is a copy of the state, so this is the memory ceiling. Thirty-two is a few hundred kilobytes for
 * the heaps the adapter's own caps allow, and enough that no point in a trace is far from one.
 */
const MAX_KEYFRAMES = 32;

/**
 * What restoring a keyframe costs, expressed in events so the routes can be compared.
 *
 * Copying the state is not free, so a keyframe two events behind the target is worse than simply
 * stepping there. Measured at roughly this many events' worth of work for the heaps the adapter
 * produces; the exact figure matters little, because the cases it decides are the ones where either
 * route is fast.
 */
const KEYFRAME_RESTORE_COST = 250;

/** What a jump-to-change search should follow. */
export type ChangeTarget =
  | { readonly kind: "variable"; readonly frame: number; readonly name: string }
  | { readonly kind: "object"; readonly obj: number }
  | { readonly kind: "slot"; readonly obj: number; readonly key: string };

export interface TraceStoreOptions {
  /**
   * Reject traces whose schema major version this build does not implement. On by default; tests
   * that construct partial traces can turn it off.
   */
  readonly checkSchema?: boolean;
}

export class TraceStore {
  readonly state: TraceState = createState();

  private readonly events: TraceEvent[] = [];
  /** Undo records for the applied prefix; index i undoes events[i]. */
  private readonly undo: UndoRecord[] = [];
  /** Number of events applied. The playhead sits immediately after events[cursor - 1]. */
  private cursor = 0;
  /** Event index of each step ordinal, so a seek by step is a lookup rather than a scan. */
  private readonly stepStarts: number[] = [];
  private session: Session | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly checkSchema: boolean;
  /** True once run_end has been appended, so the UI can distinguish streaming from finished. */
  private complete = false;

  /**
   * Detached copies of the state at intervals, so a seek does not have to replay from the beginning.
   *
   * Captured as the playhead moves *forward* and never otherwise. That is what makes them safe: the
   * undo journal behind a keyframe was necessarily built on the way past it, so restoring one and then
   * stepping backwards still has every inverse it needs.
   *
   * It is also enough in practice. A live run streams with the playhead following the edge, so by the
   * time there is a long trace to scrub, the whole of it has been walked once.
   *
   * Kept in ascending cursor order.
   */
  private readonly keyframes: { cursor: number; state: TraceState }[] = [];
  private keyframeInterval = KEYFRAME_INTERVAL;

  constructor(options: TraceStoreOptions = {}) {
    this.checkSchema = options.checkSchema ?? true;
  }

  // -------------------------------------------------------------------------
  // ingest
  // -------------------------------------------------------------------------

  /** Attach the trace header. */
  setSession(session: Session): void {
    this.session = session;
    this.notify();
  }

  getSession(): Session | undefined {
    return this.session;
  }

  /** Load a complete trace, replacing anything already held. */
  load(trace: Trace): void {
    if (this.checkSchema) assertSupportedSchema(trace.schema);
    this.clear();
    this.session = trace.session;
    this.append(trace.events);
  }

  /**
   * Add events. Safe to call repeatedly while a run streams in.
   *
   * Appending does not move the playhead. A user who has paused to look at step 12 should not be
   * yanked to step 500 because more events arrived; following the live edge is a separate,
   * explicit action.
   */
  append(events: readonly TraceEvent[]): void {
    for (const event of events) {
      const index = this.events.length;
      this.events.push(event);
      if (event.step !== undefined) {
        while (this.stepStarts.length <= event.step) this.stepStarts.push(index);
      }
      if (event.t === "run_end") this.complete = true;
    }
    this.notify();
  }

  clear(): void {
    this.events.length = 0;
    this.undo.length = 0;
    this.stepStarts.length = 0;
    this.cursor = 0;
    this.complete = false;
    this.session = undefined;
    this.keyframes.length = 0;
    this.keyframeInterval = KEYFRAME_INTERVAL;
    resetState(this.state);
    this.notify();
  }

  // -------------------------------------------------------------------------
  // shape
  // -------------------------------------------------------------------------

  /** Number of events held. */
  get eventCount(): number {
    return this.events.length;
  }

  /** Number of steps a user can land on. */
  get stepCount(): number {
    return this.stepStarts.length;
  }

  /** True once the run has ended. */
  get isComplete(): boolean {
    return this.complete;
  }

  /** True when the playhead is at the newest event held. */
  get isAtEnd(): boolean {
    return this.cursor >= this.events.length;
  }

  get isAtStart(): boolean {
    return this.cursor === 0;
  }

  /** Events applied so far. */
  get position(): number {
    return this.cursor;
  }

  eventAt(index: number): TraceEvent | undefined {
    return this.events[index];
  }

  /** All events, for views that scan history such as the timeline and output panes. */
  allEvents(): readonly TraceEvent[] {
    return this.events;
  }

  /** The event the playhead is sitting on, i.e. the most recently applied. */
  currentEvent(): TraceEvent | undefined {
    return this.cursor > 0 ? this.events[this.cursor - 1] : undefined;
  }

  // -------------------------------------------------------------------------
  // movement
  // -------------------------------------------------------------------------

  /** Apply exactly one event. Returns false at the end of what is held. */
  advanceOne(): boolean {
    const event = this.events[this.cursor];
    if (!event) return false;
    this.undo[this.cursor] = applyEvent(this.state, event);
    this.cursor++;
    this.maybeCapture();
    return true;
  }

  /** Record a keyframe if the playhead has moved far enough past the last one. */
  private maybeCapture(): void {
    const last = this.keyframes[this.keyframes.length - 1];
    if (last !== undefined && this.cursor - last.cursor < this.keyframeInterval) return;
    if (last !== undefined && this.cursor <= last.cursor) return;

    this.keyframes.push({ cursor: this.cursor, state: snapshotState(this.state) });

    // Bounded memory, uniform coverage: when there are too many, drop every other one and double the
    // interval. The trace keeps growing, so a fixed interval would not stay bounded, and thinning
    // evenly beats forgetting the oldest — the start of a run is exactly where someone scrubs back to.
    if (this.keyframes.length > MAX_KEYFRAMES) {
      for (let i = this.keyframes.length - 2; i > 0; i -= 2) this.keyframes.splice(i, 1);
      this.keyframeInterval *= 2;
    }
  }

  /** The recorded keyframe at or before `target`, if there is one. */
  private keyframeAtOrBefore(target: number): { cursor: number; state: TraceState } | undefined {
    let low = 0;
    let high = this.keyframes.length - 1;
    let found: { cursor: number; state: TraceState } | undefined;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const candidate = this.keyframes[mid]!;
      if (candidate.cursor <= target) {
        found = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  /** Undo exactly one event. Returns false at the start. */
  retreatOne(): boolean {
    if (this.cursor === 0) return false;
    const index = this.cursor - 1;
    const event = this.events[index];
    const undo = this.undo[index];
    if (!event || !undo) return false;
    revertEvent(this.state, event, undo);
    this.cursor = index;
    return true;
  }

  /**
   * Advance to the next step.
   *
   * Defined in terms of `seekStep` so that there is exactly one answer to "where is the playhead when
   * we are at step N". Stepping and seeking used to disagree: `next` stopped the instant it applied a
   * steppable event, while `seekStep` went on to apply that step's trailing effects. The same step
   * therefore had two different states depending on how it was reached, which showed up as narration
   * describing an object the store did not yet have.
   *
   * The trailing events belong to the step. A tracer reports what a line did *after* announcing the
   * next line, so those events are the effects of code that has already run.
   */
  next(): boolean {
    const target = this.state.step + 1;
    if (this.stepCount === 0 || target >= this.stepCount) {
      // No further step, but there may still be a tail — `run_end` and its notes — worth applying.
      if (!this.isAtEnd) {
        this.fastForward();
        return true;
      }
      return false;
    }
    this.seekStep(target);
    return true;
  }

  /** Retreat to the previous step. */
  prev(): boolean {
    const target = this.state.step - 1;
    if (target < 0) {
      if (this.cursor === 0) return false;
      this.seekEvent(0);
      return true;
    }
    this.seekStep(target);
    return true;
  }

  /** Move the playhead so exactly `count` events have been applied. */
  seekEvent(count: number): void {
    const target = Math.max(0, Math.min(count, this.events.length));
    this.travelTo(target);
    this.notify();
  }

  /**
   * Move the cursor to `target` by whichever route is cheapest.
   *
   * Three ways to get there: walk from where the playhead is, restore the nearest keyframe at or before
   * the target and walk forward from that, or reset and replay from the start. Stepping one event is
   * cheap in either direction because every event carries its own inverse; restoring a keyframe costs a
   * copy of the state, which is why it is not always worth it and why the comparison is made in events.
   *
   * Measured before this existed: a full-length forward jump on a 100,000-step trace cost 43ms with one
   * assignment per step and 111ms with four, against NFR-1's 50ms. Walking from the beginning was the
   * only route there was.
   */
  private travelTo(target: number): void {
    const fromHere = Math.abs(target - this.cursor);

    const keyframe = this.keyframeAtOrBefore(target);
    const viaKeyframe =
      keyframe === undefined ? Infinity : target - keyframe.cursor + KEYFRAME_RESTORE_COST;
    const fromStart = target + KEYFRAME_RESTORE_COST;

    if (viaKeyframe < fromHere && viaKeyframe <= fromStart && keyframe !== undefined) {
      restoreState(this.state, keyframe.state);
      this.cursor = keyframe.cursor;
    } else if (fromStart < fromHere) {
      resetState(this.state);
      this.cursor = 0;
    }

    while (this.cursor < target) if (!this.advanceOne()) break;
    while (this.cursor > target) if (!this.retreatOne()) break;
  }

  /**
   * Move to a step ordinal.
   *
   * Lands just past the event that opens the step, then applies its trailing bookkeeping — the
   * mutations and metrics the tracer emits for code that has already run. This is the canonical
   * position for a step, and `next` and `prev` are defined in terms of it so nothing can disagree.
   */
  seekStep(step: number): void {
    if (this.stepStarts.length === 0) return;
    const clamped = Math.max(0, Math.min(step, this.stepStarts.length - 1));
    const start = this.stepStarts[clamped];
    if (start === undefined) return;
    this.seekEvent(start + 1);
    while (this.cursor < this.events.length && !this.isSteppable(this.events[this.cursor])) {
      if (!this.advanceOne()) break;
    }
    this.notify();
  }

  /** Jump to the start. */
  rewind(): void {
    this.seekEvent(0);
  }

  /** Jump to the newest event held. */
  fastForward(): void {
    this.seekEvent(this.events.length);
  }

  // -------------------------------------------------------------------------
  // frame-aware movement
  // -------------------------------------------------------------------------

  /**
   * Step to the next stop at or shallower than the current frame, skipping over calls made from
   * this line. Depth is measured by the live stack, so it behaves correctly through recursion.
   */
  stepOver(): boolean {
    const depth = this.state.frameOrder.length;
    if (!this.next()) return false;
    while (this.state.frameOrder.length > depth) {
      if (!this.next()) return false;
    }
    return true;
  }

  /** Step until the stack is deeper than it is now, i.e. into the next call. */
  stepInto(): boolean {
    const depth = this.state.frameOrder.length;
    while (this.next()) {
      if (this.state.frameOrder.length > depth) return true;
    }
    return false;
  }

  /** Run until the current frame returns. */
  stepOut(): boolean {
    const depth = this.state.frameOrder.length;
    if (depth === 0) return false;
    while (this.next()) {
      if (this.state.frameOrder.length < depth) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // change search
  // -------------------------------------------------------------------------

  /**
   * Move to the next or previous point where a chosen variable or object changes.
   *
   * This is the answer to "when did this become wrong?", which is the question a user actually has
   * when they open a visualizer. Stepping one line at a time to find it is the slow way.
   */
  seekChange(target: ChangeTarget, direction: 1 | -1 = 1): boolean {
    const matches = (event: TraceEvent): boolean => {
      switch (target.kind) {
        case "variable":
          return (
            (event.t === "var_set" || event.t === "var_del") &&
            event.frame === target.frame &&
            event.name === target.name
          );
        case "object":
          return (
            (event.t === "obj_set" ||
              event.t === "obj_resize" ||
              event.t === "obj_free" ||
              event.t === "obj_new") &&
            event.obj === target.obj
          );
        case "slot":
          return event.t === "obj_set" && event.obj === target.obj && String(event.key) === target.key;
      }
    };

    if (direction === 1) {
      for (let i = this.cursor; i < this.events.length; i++) {
        const event = this.events[i];
        if (event && matches(event)) {
          this.seekEvent(i + 1);
          return true;
        }
      }
      return false;
    }
    for (let i = this.cursor - 2; i >= 0; i--) {
      const event = this.events[i];
      if (event && matches(event)) {
        this.seekEvent(i + 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Value of a variable in the frame under focus.
   *
   * Uses the focus frame rather than the active one, so a finished program still reports the values
   * it computed instead of appearing to have none.
   */
  lookup(name: string): Value | undefined {
    return focusFrame(this.state)?.bindings.get(name);
  }

  /** True when a named variable in the focused frame changed at the current step. */
  changedHere(name: string): boolean {
    const event = this.currentEvent();
    if (!event) return false;
    const frame = focusFrame(this.state);
    if (!frame) return false;
    for (let i = this.cursor - 1; i >= 0; i--) {
      const candidate = this.events[i];
      if (!candidate) break;
      if (candidate.step !== undefined && candidate.step !== event.step) break;
      if (
        candidate.t === "var_set" &&
        candidate.name === name &&
        candidate.frame === frame.frame &&
        !valueEquals(candidate.value, candidate.prev)
      ) {
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // subscription
  // -------------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private isSteppable(event: TraceEvent | undefined): boolean {
    return event !== undefined && STEPPABLE_EVENT_TYPES.has(event.t as EventType);
  }
}
