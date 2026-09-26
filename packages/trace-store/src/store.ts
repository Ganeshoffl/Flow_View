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
import { type TraceState, createState, focusFrame, resetState } from "./state.js";

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
    return true;
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
   * Advance to the next step boundary.
   *
   * Non-steppable events are bookkeeping — a `metric`, an `obj_set` — and are applied on the way
   * past rather than being stops of their own. Stopping on them would make a single line of source
   * take a dozen presses to get through.
   */
  next(): boolean {
    if (!this.advanceOne()) return false;
    while (!this.isSteppable(this.events[this.cursor - 1])) {
      if (!this.advanceOne()) break;
    }
    this.notify();
    return true;
  }

  /** Retreat to the previous step boundary. */
  prev(): boolean {
    if (!this.retreatOne()) return false;
    while (this.cursor > 0 && !this.isSteppable(this.events[this.cursor - 1])) {
      if (!this.retreatOne()) break;
    }
    this.notify();
    return true;
  }

  /** Move the playhead so exactly `count` events have been applied. */
  seekEvent(count: number): void {
    const target = Math.max(0, Math.min(count, this.events.length));
    // Phase 4 adds snapshot-accelerated seeking against the NFR-1 budget. Sequential replay is
    // correct at every size and fast enough for fixtures and short runs, so it is what ships now.
    while (this.cursor < target) if (!this.advanceOne()) break;
    while (this.cursor > target) if (!this.retreatOne()) break;
    this.notify();
  }

  /** Move to a step ordinal. */
  seekStep(step: number): void {
    if (this.stepStarts.length === 0) return;
    const clamped = Math.max(0, Math.min(step, this.stepStarts.length - 1));
    const start = this.stepStarts[clamped];
    if (start === undefined) return;
    // Land just past the event that opens the step, then absorb its trailing bookkeeping.
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
