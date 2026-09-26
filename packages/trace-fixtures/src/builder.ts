/**
 * A builder for hand-authored traces.
 *
 * Phase 0 builds the schema and the entire UI before any adapter exists, driven by fixtures written
 * here. That ordering is deliberate: if the trace format is wrong, this is where it is cheap to
 * discover it — after four adapters have been built on top of it, it is not.
 *
 * The builder keeps a shadow `TraceState` and advances it with the real `applyEvent`. Two things
 * follow from that. Every `prev` value is filled in from what the state actually held, so fixtures
 * cannot drift into being un-invertible; and the builder exercises the same semantics the store
 * uses, so a fixture that builds is a fixture the store can replay.
 *
 * It is also an executable specification. "What should an adapter emit for a `while` loop?" is
 * answered by reading a fixture rather than by interpreting prose.
 */

import {
  type AllocVia,
  type Arg,
  type BranchKind,
  type BranchOutcome,
  type CollapseEffect,
  type Confidence,
  type FrameKind,
  type FreeVia,
  type JumpKind,
  type Language,
  type LoopExitReason,
  type MemRegion,
  type MetricName,
  type ObjKind,
  type ObjSetOp,
  type Primitive,
  type RunStatus,
  type Session,
  type Shape,
  type StackEntry,
  type Trace,
  type TraceEvent,
  type Value,
  type VarScope,
  SCHEMA_ID,
  STEPPABLE_EVENT_TYPES,
  addr as schemaAddr,
  prim,
} from "@flow-view/trace-schema";
import { applyEvent, createState, type TraceState } from "@flow-view/trace-store";

/**
 * `Omit` over a union collapses it to the keys the members share, which for `TraceEvent` is just
 * the common envelope — every event-specific field would be rejected as excess. Distributing the
 * omit over each member first keeps the union intact.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as a caller supplies it: seq, step and ms are assigned by the builder. */
type EventDraft = DistributiveOmit<TraceEvent, "seq" | "step" | "ms">;

export interface BuilderOptions {
  readonly id?: string;
  readonly language?: Language;
  readonly languageVersion?: string;
  readonly path?: string;
  /** Source lines, used to compute a plausible line count in the header. */
  readonly source?: readonly string[];
  /** Milliseconds added per event, so the timeline has something to lay out. */
  readonly msPerEvent?: number;
}

const DEFAULT_LIMITS = {
  max_steps: 200000,
  wall_ms: 30000,
  memory_mb: 512,
  output_bytes: 1048576,
};

export class TraceBuilder {
  private readonly events: TraceEvent[] = [];
  private readonly shadow: TraceState = createState();
  private seq = 0;
  private step = 0;
  private ms = 0;
  private nextFrameId = 0;
  private nextObjId = 1;
  private nextRegionId = 1;
  private readonly frameStack: number[] = [];
  private readonly msPerEvent: number;
  private readonly path: string;
  private readonly session: Session;

  constructor(options: BuilderOptions = {}) {
    this.msPerEvent = options.msPerEvent ?? 0.1;
    this.path = options.path ?? defaultPath(options.language ?? "python");
    const source = options.source ?? [];
    this.session = {
      id: options.id ?? "fixture",
      language: options.language ?? "python",
      language_version: options.languageVersion ?? "3.12.0",
      adapter_version: "0.1.0",
      profile: "full",
      source_files: [
        { path: this.path, sha256: fakeHash(source.join("\n")), line_count: source.length },
      ],
      entry: { path: this.path, line: 1 },
      limits: DEFAULT_LIMITS,
      started_at: "2026-01-01T00:00:00Z",
    };
  }

  // -------------------------------------------------------------------------
  // emission
  // -------------------------------------------------------------------------

  private emit(draft: EventDraft): TraceEvent {
    const steppable = STEPPABLE_EVENT_TYPES.has(draft.t);
    this.ms += this.msPerEvent;
    const event = {
      ...draft,
      seq: this.seq++,
      ms: round(this.ms),
      ...(steppable ? { step: this.step++ } : {}),
    } as TraceEvent;
    this.events.push(event);
    applyEvent(this.shadow, event);
    return event;
  }

  private get frame(): number | undefined {
    return this.frameStack[this.frameStack.length - 1];
  }

  private lineOf(frameId: number | undefined): number | undefined {
    return frameId === undefined ? undefined : this.shadow.frames.get(frameId)?.line;
  }

  /** Value a name currently holds in the innermost frame, for automatic `prev`. */
  private currentBinding(name: string): Value | undefined {
    const id = this.frame;
    if (id === undefined) return undefined;
    return this.shadow.frames.get(id)?.bindings.get(name);
  }

  private currentSlot(obj: number, key: string): Value | undefined {
    return this.shadow.objects.get(obj)?.slots.get(key);
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  runStart(): this {
    this.emit({ t: "run_start" });
    return this;
  }

  runEnd(status: RunStatus = "ok", exitCode = 0): this {
    this.emit({
      t: "run_end",
      status,
      exit_code: exitCode,
      steps: this.step,
      duration_ms: round(this.ms),
    });
    return this;
  }

  // -------------------------------------------------------------------------
  // frames
  // -------------------------------------------------------------------------

  /** Push a frame and return its id. */
  push(
    func: string,
    args: readonly { name: string; value: Value }[] = [],
    options: { line?: number; kind?: FrameKind } = {},
  ): number {
    const id = this.nextFrameId++;
    const caller = this.frame;
    const depth = this.frameStack.filter(
      (f) => this.shadow.frames.get(f)?.func === func,
    ).length;
    this.emit({
      t: "frame_push",
      frame: id,
      func,
      args: args.map((a) => ({ name: a.name, value: a.value }) satisfies Arg),
      ...(caller === undefined ? {} : { caller }),
      kind: options.kind ?? "user",
      recursion_depth: depth,
      line: options.line ?? 1,
      path: this.path,
    });
    this.frameStack.push(id);
    return id;
  }

  /** Pop the innermost frame. */
  pop(returnValue?: Value, reason: "return" | "implicit" | "exception" = "return"): this {
    const id = this.frame;
    if (id === undefined) throw new Error("pop with no open frame");
    this.emit({
      t: "frame_pop",
      frame: id,
      ...(returnValue === undefined ? {} : { return_value: returnValue }),
      reason,
      line: this.lineOf(id),
      path: this.path,
    });
    this.frameStack.pop();
    return this;
  }

  /** An opaque library call: one step in, one step out, nothing visible between. */
  libraryCall(func: string, args: readonly Value[], result: Value): this {
    this.push(
      func,
      args.map((value, i) => ({ name: `arg${i}`, value })),
      { kind: "library", line: this.lineOf(this.frame) ?? 1 },
    );
    this.pop(result);
    return this;
  }

  // -------------------------------------------------------------------------
  // stepping
  // -------------------------------------------------------------------------

  /** Execute a line in the innermost frame. */
  line(n: number): this {
    this.emit({ t: "step_line", frame: this.frame, line: n, path: this.path });
    return this;
  }

  branch(
    kind: BranchKind,
    expr: string,
    outcome: BranchOutcome,
    options: { line?: number; targetLine?: number; result?: Primitive } = {},
  ): this {
    this.emit({
      t: "branch",
      frame: this.frame,
      line: options.line ?? this.lineOf(this.frame) ?? 1,
      path: this.path,
      kind,
      expr,
      outcome,
      ...(options.targetLine === undefined ? {} : { target_line: options.targetLine }),
      ...(options.result === undefined ? {} : { result: options.result }),
    });
    return this;
  }

  jump(kind: JumpKind, targetLine?: number): this {
    this.emit({
      t: "jump",
      frame: this.frame,
      line: this.lineOf(this.frame),
      path: this.path,
      kind,
      ...(targetLine === undefined ? {} : { target_line: targetLine }),
    });
    return this;
  }

  /** Open a loop region and return its id. */
  loopEnter(lineStart: number, lineEnd: number): number {
    const region = this.nextRegionId++;
    this.emit({
      t: "loop_enter",
      frame: this.frame,
      region,
      line_start: lineStart,
      line_end: lineEnd,
    });
    return region;
  }

  loopIter(region: number, i: number): this {
    this.emit({ t: "loop_iter", frame: this.frame, region, i });
    this.metric("iteration", 1);
    return this;
  }

  loopExit(region: number, iterations: number, reason: LoopExitReason = "condition"): this {
    this.emit({ t: "loop_exit", frame: this.frame, region, iterations, reason });
    return this;
  }

  // -------------------------------------------------------------------------
  // variables
  // -------------------------------------------------------------------------

  /** Bind a name, filling `prev` from what it currently holds. */
  set(name: string, value: Value, scope: VarScope = "local"): this {
    const prev = this.currentBinding(name);
    this.emit({
      t: "var_set",
      frame: this.frame,
      name,
      value,
      ...(prev === undefined ? { declared: true } : { prev }),
      scope,
    });
    this.metric("assignment", 1);
    return this;
  }

  /** Bind a primitive. */
  setPrim(name: string, value: Primitive, scope: VarScope = "local"): this {
    return this.set(name, prim(value), scope);
  }

  del(name: string): this {
    const prev = this.currentBinding(name);
    if (prev === undefined) throw new Error(`del of unbound name ${name}`);
    this.emit({ t: "var_del", frame: this.frame, name, prev });
    return this;
  }

  // -------------------------------------------------------------------------
  // heap
  // -------------------------------------------------------------------------

  /** Allocate an object and return its id. */
  newObj(
    kind: ObjKind,
    typeName: string,
    options: { summary?: string; length?: number; addr?: string; size?: number } = {},
  ): number {
    const obj = this.nextObjId++;
    this.emit({
      t: "obj_new",
      frame: this.frame,
      obj,
      kind,
      type_name: typeName,
      ...(options.summary === undefined ? {} : { summary: options.summary }),
      ...(options.length === undefined ? {} : { length: options.length }),
      ...(options.addr === undefined ? {} : { addr: options.addr }),
      ...(options.size === undefined ? {} : { size: options.size }),
    });
    this.metric("allocation", 1);
    return obj;
  }

  /** Write a slot, filling `prev` from what it currently holds. */
  objSet(obj: number, key: Primitive, value: Value, op: ObjSetOp = "set"): this {
    const prev = op === "set" ? this.currentSlot(obj, String(key)) : undefined;
    this.emit({
      t: "obj_set",
      frame: this.frame,
      obj,
      key,
      value,
      ...(prev === undefined ? {} : { prev }),
      op,
    });
    return this;
  }

  /** Append to a sequence, using the next free position as the key. */
  objAppend(obj: number, value: Value): this {
    const length = this.shadow.objects.get(obj)?.order.length ?? 0;
    return this.objSet(obj, length, value, "append");
  }

  objInsert(obj: number, at: number, value: Value): this {
    return this.objSet(obj, at, value, "insert");
  }

  objDelete(obj: number, key: Primitive): this {
    const prev = this.currentSlot(obj, String(key));
    this.emit({
      t: "obj_set",
      frame: this.frame,
      obj,
      key,
      value: prim(null),
      ...(prev === undefined ? {} : { prev }),
      op: "delete",
    });
    return this;
  }

  /** Build a list object populated from values, returning its id. */
  list(values: readonly Value[], typeName = "list"): number {
    const obj = this.newObj("list", typeName, { length: values.length });
    values.forEach((value) => this.objAppend(obj, value));
    return obj;
  }

  /** Resize, recording the keys it clears so the event stays invertible. */
  objResize(obj: number, length: number): this {
    const live = this.shadow.objects.get(obj);
    const prevLength = live?.order.length ?? 0;
    const cleared = live ? live.order.slice(length) : [];
    const clearedValues = cleared.flatMap((key) => {
      const value = live?.slots.get(key);
      return value === undefined ? [] : [value];
    });
    this.emit({
      t: "obj_resize",
      frame: this.frame,
      obj,
      length,
      prev_length: prevLength,
      ...(cleared.length ? { cleared, cleared_values: clearedValues } : {}),
    });
    return this;
  }

  objFree(obj: number): this {
    this.emit({ t: "obj_free", frame: this.frame, obj });
    return this;
  }

  // -------------------------------------------------------------------------
  // analysis
  // -------------------------------------------------------------------------

  metric(name: MetricName, delta = 1): this {
    this.emit({ t: "metric", frame: this.frame, name, delta });
    return this;
  }

  hint(
    obj: number,
    shape: Shape,
    confidence: Confidence,
    evidence: readonly string[],
    root = false,
  ): this {
    this.emit({
      t: "structure_hint",
      obj,
      shape,
      confidence,
      evidence: [...evidence],
      ...(root ? { root: true } : {}),
    });
    return this;
  }

  note(level: "info" | "warn", text: string): this {
    this.emit({ t: "note", level, text });
    return this;
  }

  /**
   * Fold a span of loop iterations into one composite step.
   *
   * `effects` must carry the before and after value of every slot the span touched. That is what
   * keeps the fold invertible: without it, stepping backward across a collapsed region would have
   * to reconstruct state from events that no longer exist.
   */
  collapse(
    region: number,
    options: {
      iterations: number;
      effects: readonly CollapseEffect[];
      metrics?: Readonly<Record<string, number>>;
      fromSeq?: number;
      toSeq?: number;
    },
  ): this {
    const from = options.fromSeq ?? this.seq;
    this.emit({
      t: "collapse",
      frame: this.frame,
      line: this.lineOf(this.frame),
      region,
      from_seq: from,
      to_seq: options.toSeq ?? from,
      iterations: options.iterations,
      effects: options.effects.map((e) => ({ ...e })),
      ...(options.metrics === undefined ? {} : { metrics: { ...options.metrics } }),
    });
    return this;
  }

  // -------------------------------------------------------------------------
  // native memory
  // -------------------------------------------------------------------------

  /** A native pointer value. */
  addrValue(address: string, type: string, dangling = false): Value {
    return schemaAddr(address, type, dangling);
  }

  memAlloc(address: string, size: number, region: MemRegion, via: AllocVia): this {
    this.emit({
      t: "mem_alloc",
      frame: this.frame,
      line: this.lineOf(this.frame),
      addr: address,
      size,
      region,
      via,
    });
    return this;
  }

  memFree(address: string, via: FreeVia): this {
    this.emit({
      t: "mem_free",
      frame: this.frame,
      line: this.lineOf(this.frame),
      addr: address,
      via,
    });
    return this;
  }

  pointerSet(
    name: string,
    toAddr: string,
    options: { valid: boolean; dangling: boolean; prevAddr?: string; obj?: number },
  ): this {
    this.emit({
      t: "ptr_set",
      frame: this.frame,
      line: this.lineOf(this.frame),
      name,
      ...(options.obj === undefined ? {} : { obj: options.obj }),
      to_addr: toAddr,
      ...(options.prevAddr === undefined ? {} : { prev_addr: options.prevAddr }),
      valid: options.valid,
      dangling: options.dangling,
    });
    return this;
  }

  // -------------------------------------------------------------------------
  // io
  // -------------------------------------------------------------------------

  out(text: string): this {
    this.emit({ t: "stdout", frame: this.frame, line: this.lineOf(this.frame), text });
    return this;
  }

  err(text: string): this {
    this.emit({ t: "stderr", frame: this.frame, line: this.lineOf(this.frame), text });
    return this;
  }

  /** A blocking read followed by the value supplied, as an interactive run records it. */
  input(prompt: string | undefined, response: string): this {
    this.emit({
      t: "stdin_request",
      frame: this.frame,
      line: this.lineOf(this.frame),
      ...(prompt === undefined ? {} : { prompt }),
    });
    this.emit({ t: "stdin_response", frame: this.frame, text: response, source: "interactive" });
    return this;
  }

  // -------------------------------------------------------------------------
  // errors
  // -------------------------------------------------------------------------

  raise(type: string, message: string, obj?: number): this {
    this.emit({
      t: "exception_raise",
      frame: this.frame,
      line: this.lineOf(this.frame),
      path: this.path,
      type,
      message,
      ...(obj === undefined ? {} : { obj }),
    });
    return this;
  }

  catchAt(handlerLine: number): this {
    this.emit({
      t: "exception_catch",
      frame: this.frame,
      line: handlerLine,
      path: this.path,
      handler_line: handlerLine,
    });
    return this;
  }

  uncaught(type: string, message: string, stack: readonly StackEntry[]): this {
    this.emit({ t: "exception_uncaught", type, message, stack: [...stack] });
    return this;
  }

  // -------------------------------------------------------------------------
  // result
  // -------------------------------------------------------------------------

  /** Finish, closing any frames left open so the trace satisfies its invariants. */
  build(): Trace {
    while (this.frameStack.length > 0) this.pop(undefined, "implicit");
    if (this.shadow.status === undefined) this.runEnd("ok");
    return { schema: SCHEMA_ID, session: this.session, events: this.events };
  }

  /** Read-only view of the shadow state, for assertions while composing a fixture. */
  get currentState(): TraceState {
    return this.shadow;
  }
}

function defaultPath(language: Language): string {
  const ext: Record<Language, string> = {
    python: "main.py",
    javascript: "main.js",
    c: "main.c",
    cpp: "main.cpp",
    java: "Main.java",
  };
  return ext[language];
}

/** A stable stand-in for a real digest. Fixtures are not verified against source on disk. */
function fakeHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").repeat(8);
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
