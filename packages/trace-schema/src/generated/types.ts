// DO NOT EDIT. Generated from packages/trace-schema/model/trace.model.json
// Regenerate with: pnpm schema:gen

export const SCHEMA_ID = "flow_view/trace@1" as const;
export const SCHEMA_VERSION_MAJOR = 1 as const;

/** A JSON primitive as carried in a trace. */
export type Primitive = null | boolean | number | string;

/** Languages flow_view can trace. */
export type Language =
  | "python"
  | "javascript"
  | "c"
  | "cpp"
  | "java";

export const LANGUAGE_VALUES = ["python", "javascript", "c", "cpp", "java"] as const satisfies readonly Language[];

/** Deployment profile that produced the trace. */
export type Profile =
  | "lite"
  | "full";

export const PROFILE_VALUES = ["lite", "full"] as const satisfies readonly Profile[];

/**
 * How the run ended. Every status other than ok/error means the trace is truncated but still
 * valid and replayable.
 */
export type RunStatus =
  | "ok"
  | "error"
  | "timeout"
  | "step_limit"
  | "memory_limit"
  | "killed";

export const RUNSTATUS_VALUES = ["ok", "error", "timeout", "step_limit", "memory_limit", "killed"] as const satisfies readonly RunStatus[];

/** Syntactic construct that made a control-flow decision. */
export type BranchKind =
  | "if"
  | "elif"
  | "else"
  | "while"
  | "for"
  | "switch"
  | "ternary"
  | "guard";

export const BRANCHKIND_VALUES = ["if", "elif", "else", "while", "for", "switch", "ternary", "guard"] as const satisfies readonly BranchKind[];

/**
 * Which way control actually went. Derived from observed execution, never by re-evaluating the
 * condition.
 */
export type BranchOutcome =
  | "taken"
  | "not_taken";

export const BRANCHOUTCOME_VALUES = ["taken", "not_taken"] as const satisfies readonly BranchOutcome[];

/** Why a loop stopped iterating. */
export type LoopExitReason =
  | "condition"
  | "break"
  | "return"
  | "exception";

export const LOOPEXITREASON_VALUES = ["condition", "break", "return", "exception"] as const satisfies readonly LoopExitReason[];

/** Non-linear control transfer. */
export type JumpKind =
  | "break"
  | "continue"
  | "goto";

export const JUMPKIND_VALUES = ["break", "continue", "goto"] as const satisfies readonly JumpKind[];

/**
 * Nature of a call frame. 'library' marks an opaque call whose interior is deliberately not
 * traced.
 */
export type FrameKind =
  | "user"
  | "library"
  | "builtin"
  | "method"
  | "constructor";

export const FRAMEKIND_VALUES = ["user", "library", "builtin", "method", "constructor"] as const satisfies readonly FrameKind[];

/** Why a frame was popped. */
export type FramePopReason =
  | "return"
  | "implicit"
  | "exception";

export const FRAMEPOPREASON_VALUES = ["return", "implicit", "exception"] as const satisfies readonly FramePopReason[];

/** Binding scope of a variable. */
export type VarScope =
  | "local"
  | "param"
  | "global"
  | "closure"
  | "static"
  | "field";

export const VARSCOPE_VALUES = ["local", "param", "global", "closure", "static", "field"] as const satisfies readonly VarScope[];

/** Renderer hint for a heap object. Describes representation, not semantics. */
export type ObjKind =
  | "list"
  | "array"
  | "tuple"
  | "string"
  | "bytes"
  | "set"
  | "map"
  | "object"
  | "instance"
  | "struct"
  | "function"
  | "closure"
  | "class"
  | "module"
  | "iterator"
  | "generator"
  | "exception"
  | "pointer"
  | "opaque";

export const OBJKIND_VALUES = ["list", "array", "tuple", "string", "bytes", "set", "map", "object", "instance", "struct", "function", "closure", "class", "module", "iterator", "generator", "exception", "pointer", "opaque"] as const satisfies readonly ObjKind[];

/**
 * Kind of mutation. Distinguishes replacing element 3 from inserting at 3, which animate
 * differently.
 */
export type ObjSetOp =
  | "set"
  | "insert"
  | "append"
  | "delete";

export const OBJSETOP_VALUES = ["set", "insert", "append", "delete"] as const satisfies readonly ObjSetOp[];

/** Native memory region. */
export type MemRegion =
  | "heap"
  | "stack";

export const MEMREGION_VALUES = ["heap", "stack"] as const satisfies readonly MemRegion[];

/** Native allocation mechanism. */
export type AllocVia =
  | "malloc"
  | "calloc"
  | "realloc"
  | "new"
  | "new_array"
  | "alloca";

export const ALLOCVIA_VALUES = ["malloc", "calloc", "realloc", "new", "new_array", "alloca"] as const satisfies readonly AllocVia[];

/** Native deallocation mechanism. */
export type FreeVia =
  | "free"
  | "delete"
  | "delete_array"
  | "scope_exit";

export const FREEVIA_VALUES = ["free", "delete", "delete_array", "scope_exit"] as const satisfies readonly FreeVia[];

/**
 * Whether input came from a human at run time or was supplied up front. Measured from how long
 * the read blocked, not assumed.
 */
export type StdinSource =
  | "interactive"
  | "prefilled";

export const STDINSOURCE_VALUES = ["interactive", "prefilled"] as const satisfies readonly StdinSource[];

/** Counters surfaced in the metrics view. */
export type MetricName =
  | "comparison"
  | "swap"
  | "assignment"
  | "call"
  | "iteration"
  | "allocation"
  | "read"
  | "write";

export const METRICNAME_VALUES = ["comparison", "swap", "assignment", "call", "iteration", "allocation", "read", "write"] as const satisfies readonly MetricName[];

/**
 * Inferred data structure shape. Advisory; always user-overridable. 'unknown' renders as a
 * generic object graph.
 */
export type Shape =
  | "array"
  | "matrix"
  | "string"
  | "tuple"
  | "set"
  | "map"
  | "linked_list"
  | "doubly_linked_list"
  | "circular_linked_list"
  | "binary_tree"
  | "bst"
  | "nary_tree"
  | "directed_graph"
  | "undirected_graph"
  | "stack"
  | "queue"
  | "deque"
  | "object"
  | "unknown";

export const SHAPE_VALUES = ["array", "matrix", "string", "tuple", "set", "map", "linked_list", "doubly_linked_list", "circular_linked_list", "binary_tree", "bst", "nary_tree", "directed_graph", "undirected_graph", "stack", "queue", "deque", "object", "unknown"] as const satisfies readonly Shape[];

/** How much to trust an inference. */
export type Confidence =
  | "high"
  | "medium"
  | "low";

export const CONFIDENCE_VALUES = ["high", "medium", "low"] as const satisfies readonly Confidence[];

/** Severity of an adapter diagnostic shown to the user. */
export type NoteLevel =
  | "info"
  | "warn";

export const NOTELEVEL_VALUES = ["info", "warn"] as const satisfies readonly NoteLevel[];

/**
 * An immediate value. Integers outside IEEE-754 safe range are strings with bigint set. NaN
 * and infinities are the strings 'nan', 'inf', '-inf'.
 */
export interface ValuePrim {
  /** null, bool, int, float, or string. */
  readonly prim: Primitive;
  /** Set when prim is a string carrying an integer too large for a double. */
  readonly bigint?: boolean;
  /** Full original length, when a long string was shortened. */
  readonly truncated?: number;
}

/** A reference to a heap object. */
export interface ValueRef {
  /** Heap object id. */
  readonly ref: number;
}

/** A native pointer (C/C++). */
export interface ValueAddr {
  /** Hex address, e.g. '0x7ffd1a2b'. */
  readonly addr: string;
  /** Declared pointee type, e.g. 'int*'. */
  readonly type: string;
  /** Target memory has been freed. */
  readonly dangling?: boolean;
}

/**
 * The runtime could not report this value. Deliberate: an honest gap beats a fabricated
 * number.
 */
export interface ValueUnavailable {
  /** Human-readable reason, e.g. 'optimized out'. */
  readonly unavailable: string;
}

/**
 * A value held by a variable or heap slot. Never a nested object: aggregates are referenced by
 * id so that aliasing and cycles are representable, and so mutating a shared object is one
 * event rather than many. Exactly one variant key must be present.
 */
export type Value =
  | ValuePrim
  | ValueRef
  | ValueAddr
  | ValueUnavailable;

export const isValuePrim = (v: Value): v is ValuePrim => "prim" in v;
export const isValueRef = (v: Value): v is ValueRef => "ref" in v;
export const isValueAddr = (v: Value): v is ValueAddr => "addr" in v;
export const isValueUnavailable = (v: Value): v is ValueUnavailable => "unavailable" in v;

/** One argument at a call site. */
export interface Arg {
  readonly name: string;
  readonly value: Value;
}

/** A source file participating in the run. */
export interface SourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly line_count: number;
}

/** Where execution began. */
export interface EntryPoint {
  readonly path: string;
  readonly line: number;
}

/** Resource bounds applied to the run. Present so the UI can explain a truncated trace. */
export interface Limits {
  readonly max_steps: number;
  readonly wall_ms: number;
  readonly memory_mb: number;
  readonly output_bytes: number;
}

/** Trace header. Sent once, before any events. */
export interface Session {
  readonly id: string;
  readonly language: Language;
  readonly language_version: string;
  readonly adapter_version: string;
  readonly profile: Profile;
  readonly source_files: SourceFile[];
  readonly entry: EntryPoint;
  readonly limits: Limits;
  /** ISO 8601 UTC. */
  readonly started_at: string;
  /**
   * Sandbox guards actually in force on this platform. The UI reports these verbatim rather than
   * implying protection that is not present.
   */
  readonly guards_active?: string[];
}

/** One line of a rendered stack trace. */
export interface StackEntry {
  readonly func: string;
  readonly path: string;
  readonly line: number;
}

/**
 * Net before/after state for one slot touched inside a folded span. This is what makes a
 * collapse event invertible.
 */
export interface CollapseEffect {
  /** 'var' or 'obj'. */
  readonly kind: string;
  /** Owning frame, for kind 'var'. */
  readonly frame?: number;
  /** Owning object, for kind 'obj'. */
  readonly obj?: number;
  /** Variable name, or heap key rendered as a string. */
  readonly key: string;
  readonly before?: Value;
  readonly after?: Value;
}

/** A frame as captured in a snapshot. */
export interface FrameState {
  readonly frame: number;
  readonly func: string;
  readonly path: string;
  readonly line: number;
  readonly kind: FrameKind;
  readonly caller?: number;
  readonly recursion_depth: number;
  /** Variable name to current value. */
  readonly bindings: Record<string, Value>;
  /** Variable name to its VarScope. */
  readonly scopes?: Record<string, string>;
}

/** A heap object as captured in a snapshot. */
export interface ObjectState {
  readonly obj: number;
  readonly kind: ObjKind;
  readonly type_name: string;
  /** Key (index or field, rendered as a string) to value. */
  readonly slots: Record<string, Value>;
  /** Explicit slot ordering where it is meaningful, as for lists and arrays. */
  readonly order?: string[];
  readonly length?: number;
  readonly addr?: string;
  readonly shape?: Shape;
  readonly summary?: string;
}

/** An active loop region as captured in a snapshot. */
export interface LoopState {
  readonly region: number;
  readonly line_start: number;
  readonly line_end: number;
  readonly iteration: number;
}

/**
 * Program state at a point in the trace. Delta-encoded against base_seq unless full is set: a
 * whole-heap snapshot every few hundred steps would outweigh the events it exists to
 * accelerate.
 */
export interface StateSnapshot {
  /** True for a keyframe carrying complete state; false for a delta. */
  readonly full: boolean;
  /** Snapshot this delta applies to. Absent when full. */
  readonly base_seq?: number;
  readonly frames: FrameState[];
  /** Frame ids, outermost first. */
  readonly frame_order: number[];
  readonly objects: ObjectState[];
  /** Frames gone since base_seq, for deltas. */
  readonly removed_frames?: number[];
  /** Objects gone since base_seq, for deltas. */
  readonly removed_objects?: number[];
  readonly loops?: LoopState[];
  /** Metric name to running total. */
  readonly metrics?: Record<string, number>;
}

/** Fields carried by every event. Only seq and t are universally required. */
export interface EventBase {
  /** Monotonic from 0. Identity of a point in time. */
  readonly seq: number;
  /** Event type. */
  readonly t: string;
  /** Step ordinal. Present on events the user can land on; absent on bookkeeping events. */
  readonly step?: number;
  /** Owning frame id. */
  readonly frame?: number;
  /** 1-based source line. */
  readonly line?: number;
  /** Source file. Omitted when it is the entry file. */
  readonly path?: string;
  /** Milliseconds since run start, for the timeline view. */
  readonly ms?: number;
}

/** `run_start` — First event of every trace. */
export interface RunStartEvent extends EventBase {
  readonly t: "run_start";
}

/** `run_end` — Always emitted, including on limit breach. A truncated trace is a valid trace. */
export interface RunEndEvent extends EventBase {
  readonly t: "run_end";
  readonly status: RunStatus;
  readonly exit_code?: number;
  readonly steps: number;
  readonly duration_ms: number;
}

/** `step_line` — Execution arrived at a line. The atom of playback. */
export interface StepLineEvent extends EventBase {
  readonly t: "step_line";
}

/**
 * `branch` — A control-flow decision. outcome comes from observed execution; the condition is
 * never re-evaluated, since doing so could fire side effects and change the program being
 * visualized.
 */
export interface BranchEvent extends EventBase {
  readonly t: "branch";
  readonly kind: BranchKind;
  /** Source text of the condition, read from the AST. */
  readonly expr: string;
  readonly outcome: BranchOutcome;
  readonly target_line?: number;
  /**
   * Evaluated value, only where the runtime surfaces it for free. Null for settrace-based
   * Python. No view may depend on it.
   */
  readonly result?: Primitive;
}

/** `loop_enter` — Opens a loop region. */
export interface LoopEnterEvent extends EventBase {
  readonly t: "loop_enter";
  readonly region: number;
  readonly line_start: number;
  readonly line_end: number;
}

/** `loop_iter` — One iteration boundary. Basis for collapsing. */
export interface LoopIterEvent extends EventBase {
  readonly t: "loop_iter";
  readonly region: number;
  readonly i: number;
}

/** `loop_exit` — Closes a loop region. */
export interface LoopExitEvent extends EventBase {
  readonly t: "loop_exit";
  readonly region: number;
  readonly iterations: number;
  readonly reason: LoopExitReason;
}

/** `jump` — Non-linear control transfer. */
export interface JumpEvent extends EventBase {
  readonly t: "jump";
  readonly kind: JumpKind;
  readonly target_line?: number;
}

/**
 * `frame_push` — A call began. Frame ids are unique for the whole run and never reused, so
 * recursion yields a distinct frame per depth.
 */
export interface FramePushEvent extends EventBase {
  readonly t: "frame_push";
  readonly func: string;
  readonly args: Arg[];
  readonly caller?: number;
  readonly kind: FrameKind;
  readonly recursion_depth: number;
}

/** `frame_pop` — A call returned. */
export interface FramePopEvent extends EventBase {
  readonly t: "frame_pop";
  readonly return_value?: Value;
  readonly reason: FramePopReason;
}

/**
 * `var_set` — A variable was bound or rebound. prev is what it held before, which is what
 * makes the event invertible.
 */
export interface VarSetEvent extends EventBase {
  readonly t: "var_set";
  readonly name: string;
  readonly value: Value;
  /** Absent when the name did not previously exist. */
  readonly prev?: Value;
  readonly scope: VarScope;
  /** True on first binding. */
  readonly declared?: boolean;
}

/** `var_del` — A binding disappeared: scope exit, explicit delete, block end. */
export interface VarDelEvent extends EventBase {
  readonly t: "var_del";
  readonly name: string;
  readonly prev: Value;
}

/** `obj_new` — A heap object came into existence. */
export interface ObjNewEvent extends EventBase {
  readonly t: "obj_new";
  readonly obj: number;
  readonly kind: ObjKind;
  readonly type_name: string;
  readonly size?: number;
  /** Real address for C/C++; absent for managed languages. */
  readonly addr?: string;
  readonly summary?: string;
  readonly length?: number;
}

/** `obj_set` — A slot of a heap object changed. */
export interface ObjSetEvent extends EventBase {
  readonly t: "obj_set";
  readonly obj: number;
  /** Index for sequences; field name or map key otherwise. */
  readonly key: Primitive;
  readonly value: Value;
  readonly prev?: Value;
  readonly op: ObjSetOp;
}

/** `obj_resize` — Bulk length change: clear, extend, array reallocation. */
export interface ObjResizeEvent extends EventBase {
  readonly t: "obj_resize";
  readonly obj: number;
  readonly length: number;
  readonly prev_length: number;
  /** Keys removed by the resize, so the event stays invertible. */
  readonly cleared?: string[];
  /** Values those keys held, positionally aligned with cleared. */
  readonly cleared_values?: Value[];
}

/** `obj_free` — Explicit deallocation. C/C++ only; managed languages do not report collection. */
export interface ObjFreeEvent extends EventBase {
  readonly t: "obj_free";
  readonly obj: number;
}

/** `mem_alloc` — Native allocation. */
export interface MemAllocEvent extends EventBase {
  readonly t: "mem_alloc";
  readonly addr: string;
  readonly size: number;
  readonly region: MemRegion;
  readonly via: AllocVia;
}

/** `mem_free` — Native deallocation. */
export interface MemFreeEvent extends EventBase {
  readonly t: "mem_free";
  readonly addr: string;
  readonly via: FreeVia;
}

/**
 * `ptr_set` — A pointer was retargeted. dangling is the highest-value teaching signal in C: it
 * is what draws the broken arrow explaining a use-after-free.
 */
export interface PtrSetEvent extends EventBase {
  readonly t: "ptr_set";
  readonly name?: string;
  readonly obj?: number;
  readonly to_addr: string;
  readonly prev_addr?: string;
  readonly valid: boolean;
  readonly dangling: boolean;
}

/** `stdout` — Standard output, attributed to the step that produced it. */
export interface StdoutEvent extends EventBase {
  readonly t: "stdout";
  readonly text: string;
}

/** `stderr` — Standard error, attributed to the step that produced it. */
export interface StderrEvent extends EventBase {
  readonly t: "stderr";
  readonly text: string;
}

/** `stdin_request` — Execution is blocked awaiting input. */
export interface StdinRequestEvent extends EventBase {
  readonly t: "stdin_request";
  readonly prompt?: string;
}

/**
 * `stdin_response` — Input that was supplied. Recorded so replay is deterministic without a
 * human. waited_ms is how long the program actually sat on the read, and is what source is
 * derived from.
 */
export interface StdinResponseEvent extends EventBase {
  readonly t: "stdin_response";
  readonly text: string;
  readonly source: StdinSource;
  readonly waited_ms?: number;
}

/** `exception_raise` — An exception was raised. */
export interface ExceptionRaiseEvent extends EventBase {
  readonly t: "exception_raise";
  readonly type: string;
  readonly message: string;
  readonly obj?: number;
}

/** `exception_catch` — An exception was handled. */
export interface ExceptionCatchEvent extends EventBase {
  readonly t: "exception_catch";
  readonly handler_line: number;
}

/**
 * `exception_uncaught` — An exception terminated the program. Terminal, but the trace stays
 * replayable.
 */
export interface ExceptionUncaughtEvent extends EventBase {
  readonly t: "exception_uncaught";
  readonly type: string;
  readonly message: string;
  readonly stack: StackEntry[];
}

/** `metric` — Counter increment for the metrics view. */
export interface MetricEvent extends EventBase {
  readonly t: "metric";
  readonly name: MetricName;
  readonly delta: number;
  readonly region?: number;
}

/**
 * `structure_hint` — Inferred shape of an object. Advisory, overridable, and carries its
 * evidence so a wrong guess is explainable rather than mysterious.
 */
export interface StructureHintEvent extends EventBase {
  readonly t: "structure_hint";
  readonly obj: number;
  readonly shape: Shape;
  readonly confidence: Confidence;
  /** Human-readable reasons, shown in the UI. */
  readonly evidence: string[];
  /** True when this object is the entry point of the structure. */
  readonly root?: boolean;
}

/** `snapshot` — Periodic state capture bounding how far a seek must replay. */
export interface SnapshotEvent extends EventBase {
  readonly t: "snapshot";
  readonly state: StateSnapshot;
}

/**
 * `collapse` — A folded span of repeated loop iterations, represented as one composite
 * invertible step. Carries net before/after state so folding cannot break the invertibility
 * guarantee.
 */
export interface CollapseEvent extends EventBase {
  readonly t: "collapse";
  readonly region: number;
  readonly from_seq: number;
  readonly to_seq: number;
  readonly iterations: number;
  /**
   * Index of the first folded iteration. Together with to_iter this is what expand-on-demand
   * re-runs; seq numbers do not survive into a re-run.
   */
  readonly from_iter?: number;
  /** Index of the last folded iteration. */
  readonly to_iter?: number;
  readonly effects: CollapseEffect[];
  readonly metrics?: Record<string, number>;
}

/**
 * `note` — Adapter diagnostic surfaced to the user, such as a step budget being reached or a
 * frame whose locals could not be read.
 */
export interface NoteEvent extends EventBase {
  readonly t: "note";
  readonly level: NoteLevel;
  readonly text: string;
}

/** Any trace event. Discriminated on `t`. */
export type TraceEvent =
  | RunStartEvent
  | RunEndEvent
  | StepLineEvent
  | BranchEvent
  | LoopEnterEvent
  | LoopIterEvent
  | LoopExitEvent
  | JumpEvent
  | FramePushEvent
  | FramePopEvent
  | VarSetEvent
  | VarDelEvent
  | ObjNewEvent
  | ObjSetEvent
  | ObjResizeEvent
  | ObjFreeEvent
  | MemAllocEvent
  | MemFreeEvent
  | PtrSetEvent
  | StdoutEvent
  | StderrEvent
  | StdinRequestEvent
  | StdinResponseEvent
  | ExceptionRaiseEvent
  | ExceptionCatchEvent
  | ExceptionUncaughtEvent
  | MetricEvent
  | StructureHintEvent
  | SnapshotEvent
  | CollapseEvent
  | NoteEvent;

/** Event type names. */
export type EventType = TraceEvent['t'];

export const EVENT_TYPES = [
  "run_start",
  "run_end",
  "step_line",
  "branch",
  "loop_enter",
  "loop_iter",
  "loop_exit",
  "jump",
  "frame_push",
  "frame_pop",
  "var_set",
  "var_del",
  "obj_new",
  "obj_set",
  "obj_resize",
  "obj_free",
  "mem_alloc",
  "mem_free",
  "ptr_set",
  "stdout",
  "stderr",
  "stdin_request",
  "stdin_response",
  "exception_raise",
  "exception_catch",
  "exception_uncaught",
  "metric",
  "structure_hint",
  "snapshot",
  "collapse",
  "note",
] as const satisfies readonly EventType[];

/**
 * Event types a user can land on when stepping. Other events mutate state or carry
 * bookkeeping, and are applied while passing over them.
 */
export const STEPPABLE_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  "step_line",
  "branch",
  "jump",
  "frame_push",
  "frame_pop",
  "exception_raise",
  "exception_catch",
  "collapse",
]);

/** Event types by functional group. */
export const EVENT_GROUPS = {
  lifecycle: ["run_start", "run_end"],
  stepping: ["step_line", "branch", "loop_enter", "loop_iter", "loop_exit", "jump"],
  frames: ["frame_push", "frame_pop"],
  variables: ["var_set", "var_del"],
  heap: ["obj_new", "obj_set", "obj_resize", "obj_free"],
  native: ["mem_alloc", "mem_free", "ptr_set"],
  io: ["stdout", "stderr", "stdin_request", "stdin_response"],
  errors: ["exception_raise", "exception_catch", "exception_uncaught"],
  analysis: ["metric", "structure_hint", "snapshot", "collapse", "note"],
} as const;

/** A complete trace: header plus events. A saved trace file has this shape. */
export interface Trace {
  readonly schema: typeof SCHEMA_ID;
  readonly session: Session;
  readonly events: readonly TraceEvent[];
}

/**
 * Narrow an event by type. Keeps call sites free of casts: `if (isEvent(e, 'var_set')) {
 * e.name }`.
 */
export function isEvent<T extends EventType>(
  event: TraceEvent,
  type: T,
): event is Extract<TraceEvent, { t: T }> {
  return event.t === type;
}
