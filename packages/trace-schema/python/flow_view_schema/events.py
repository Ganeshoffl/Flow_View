"""DO NOT EDIT. Generated from packages/trace-schema/model/trace.model.json
Regenerate with: pnpm schema:gen"""

from __future__ import annotations

from typing import Literal, TypedDict, Union

SCHEMA_ID = "flow_view/trace@1"
SCHEMA_VERSION_MAJOR = 1

Primitive = Union[None, bool, int, float, str]

Language = Literal["python", "javascript", "c", "cpp", "java"]
"""Languages flow_view can trace."""
LANGUAGE_VALUES: tuple[Language, ...] = ("python", "javascript", "c", "cpp", "java",)

Profile = Literal["lite", "full"]
"""Deployment profile that produced the trace."""
PROFILE_VALUES: tuple[Profile, ...] = ("lite", "full",)

RunStatus = Literal["ok", "error", "timeout", "step_limit", "memory_limit", "killed"]
"""How the run ended. Every status other than ok/error means the trace is truncated but
still valid and replayable.
"""
RUNSTATUS_VALUES: tuple[RunStatus, ...] = ("ok", "error", "timeout", "step_limit", "memory_limit", "killed",)

BranchKind = Literal["if", "elif", "else", "while", "for", "switch", "ternary", "guard"]
"""Syntactic construct that made a control-flow decision."""
BRANCHKIND_VALUES: tuple[BranchKind, ...] = ("if", "elif", "else", "while", "for", "switch", "ternary", "guard",)

BranchOutcome = Literal["taken", "not_taken"]
"""Which way control actually went. Derived from observed execution, never by re-evaluating
the condition.
"""
BRANCHOUTCOME_VALUES: tuple[BranchOutcome, ...] = ("taken", "not_taken",)

LoopExitReason = Literal["condition", "break", "return", "exception"]
"""Why a loop stopped iterating."""
LOOPEXITREASON_VALUES: tuple[LoopExitReason, ...] = ("condition", "break", "return", "exception",)

JumpKind = Literal["break", "continue", "goto"]
"""Non-linear control transfer."""
JUMPKIND_VALUES: tuple[JumpKind, ...] = ("break", "continue", "goto",)

FrameKind = Literal["user", "library", "builtin", "method", "constructor"]
"""Nature of a call frame. 'library' marks an opaque call whose interior is deliberately
not traced.
"""
FRAMEKIND_VALUES: tuple[FrameKind, ...] = ("user", "library", "builtin", "method", "constructor",)

FramePopReason = Literal["return", "implicit", "exception"]
"""Why a frame was popped."""
FRAMEPOPREASON_VALUES: tuple[FramePopReason, ...] = ("return", "implicit", "exception",)

VarScope = Literal["local", "param", "global", "closure", "static", "field"]
"""Binding scope of a variable."""
VARSCOPE_VALUES: tuple[VarScope, ...] = ("local", "param", "global", "closure", "static", "field",)

ObjKind = Literal["list", "array", "tuple", "string", "bytes", "set", "map", "object", "instance", "struct", "function", "closure", "class", "module", "iterator", "generator", "exception", "pointer", "opaque"]
"""Renderer hint for a heap object. Describes representation, not semantics."""
OBJKIND_VALUES: tuple[ObjKind, ...] = ("list", "array", "tuple", "string", "bytes", "set", "map", "object", "instance", "struct", "function", "closure", "class", "module", "iterator", "generator", "exception", "pointer", "opaque",)

ObjSetOp = Literal["set", "insert", "append", "delete"]
"""Kind of mutation. Distinguishes replacing element 3 from inserting at 3, which animate
differently.
"""
OBJSETOP_VALUES: tuple[ObjSetOp, ...] = ("set", "insert", "append", "delete",)

MemRegion = Literal["heap", "stack"]
"""Native memory region."""
MEMREGION_VALUES: tuple[MemRegion, ...] = ("heap", "stack",)

AllocVia = Literal["malloc", "calloc", "realloc", "new", "new_array", "alloca"]
"""Native allocation mechanism."""
ALLOCVIA_VALUES: tuple[AllocVia, ...] = ("malloc", "calloc", "realloc", "new", "new_array", "alloca",)

FreeVia = Literal["free", "delete", "delete_array", "scope_exit"]
"""Native deallocation mechanism."""
FREEVIA_VALUES: tuple[FreeVia, ...] = ("free", "delete", "delete_array", "scope_exit",)

StdinSource = Literal["interactive", "prefilled"]
"""Whether input came from a human at run time or was supplied up front."""
STDINSOURCE_VALUES: tuple[StdinSource, ...] = ("interactive", "prefilled",)

MetricName = Literal["comparison", "swap", "assignment", "call", "iteration", "allocation", "read", "write"]
"""Counters surfaced in the metrics view."""
METRICNAME_VALUES: tuple[MetricName, ...] = ("comparison", "swap", "assignment", "call", "iteration", "allocation", "read", "write",)

Shape = Literal["array", "matrix", "string", "tuple", "set", "map", "linked_list", "doubly_linked_list", "circular_linked_list", "binary_tree", "bst", "nary_tree", "directed_graph", "undirected_graph", "stack", "queue", "deque", "object", "unknown"]
"""Inferred data structure shape. Advisory; always user-overridable. 'unknown' renders as a
generic object graph.
"""
SHAPE_VALUES: tuple[Shape, ...] = ("array", "matrix", "string", "tuple", "set", "map", "linked_list", "doubly_linked_list", "circular_linked_list", "binary_tree", "bst", "nary_tree", "directed_graph", "undirected_graph", "stack", "queue", "deque", "object", "unknown",)

Confidence = Literal["high", "medium", "low"]
"""How much to trust an inference."""
CONFIDENCE_VALUES: tuple[Confidence, ...] = ("high", "medium", "low",)

NoteLevel = Literal["info", "warn"]
"""Severity of an adapter diagnostic shown to the user."""
NOTELEVEL_VALUES: tuple[NoteLevel, ...] = ("info", "warn",)

class ValuePrim(TypedDict):
    """An immediate value. Integers outside IEEE-754 safe range are strings with bigint
    set. NaN and infinities are the strings 'nan', 'inf', '-inf'.
    """
    prim: Primitive
    """null, bool, int, float, or string."""

class ValuePrimOpt(ValuePrim, total=False):
    """Optional members."""
    bigint: bool
    truncated: int

class ValueRef(TypedDict):
    """A reference to a heap object."""
    ref: int
    """Heap object id."""

class ValueAddr(TypedDict):
    """A native pointer (C/C++)."""
    addr: str
    """Hex address, e.g. '0x7ffd1a2b'."""
    type: str
    """Declared pointee type, e.g. 'int*'."""

class ValueAddrOpt(ValueAddr, total=False):
    """Optional members."""
    dangling: bool

class ValueUnavailable(TypedDict):
    """The runtime could not report this value. Deliberate: an honest gap beats a
    fabricated number.
    """
    unavailable: str
    """Human-readable reason, e.g. 'optimized out'."""

Value = Union[ValuePrimOpt, ValueRef, ValueAddrOpt, ValueUnavailable]
"""A value held by a variable or heap slot. Never a nested object: aggregates are
referenced by id so that aliasing and cycles are representable, and so mutating a shared
object is one event rather than many. Exactly one variant key must be present.
"""

class Arg(TypedDict):
    """One argument at a call site."""
    name: str
    value: Value

class SourceFile(TypedDict):
    """A source file participating in the run."""
    path: str
    sha256: str
    line_count: int

class EntryPoint(TypedDict):
    """Where execution began."""
    path: str
    line: int

class Limits(TypedDict):
    """Resource bounds applied to the run. Present so the UI can explain a truncated trace."""
    max_steps: int
    wall_ms: int
    memory_mb: int
    output_bytes: int

class _SessionReq(TypedDict):
    """Trace header. Sent once, before any events."""
    id: str
    language: Language
    language_version: str
    adapter_version: str
    profile: Profile
    source_files: list[SourceFile]
    entry: EntryPoint
    limits: Limits
    started_at: str
    """ISO 8601 UTC."""

class Session(_SessionReq, total=False):
    """Trace header. Sent once, before any events. (with optional members)"""
    guards_active: list[str]

class StackEntry(TypedDict):
    """One line of a rendered stack trace."""
    func: str
    path: str
    line: int

class _CollapseEffectReq(TypedDict):
    """Net before/after state for one slot touched inside a folded span. This is what makes
    a collapse event invertible.
    """
    kind: str
    """'var' or 'obj'."""
    key: str
    """Variable name, or heap key rendered as a string."""

class CollapseEffect(_CollapseEffectReq, total=False):
    """Net before/after state for one slot touched inside a folded span. This is what makes
    a collapse event invertible. (with optional members)
    """
    frame: int
    obj: int
    before: Value
    after: Value

class _FrameStateReq(TypedDict):
    """A frame as captured in a snapshot."""
    frame: int
    func: str
    path: str
    line: int
    kind: FrameKind
    recursion_depth: int
    bindings: dict[str, Value]
    """Variable name to current value."""

class FrameState(_FrameStateReq, total=False):
    """A frame as captured in a snapshot. (with optional members)"""
    caller: int
    scopes: dict[str, str]

class _ObjectStateReq(TypedDict):
    """A heap object as captured in a snapshot."""
    obj: int
    kind: ObjKind
    type_name: str
    slots: dict[str, Value]
    """Key (index or field, rendered as a string) to value."""

class ObjectState(_ObjectStateReq, total=False):
    """A heap object as captured in a snapshot. (with optional members)"""
    order: list[str]
    length: int
    addr: str
    shape: Shape
    summary: str

class LoopState(TypedDict):
    """An active loop region as captured in a snapshot."""
    region: int
    line_start: int
    line_end: int
    iteration: int

class _StateSnapshotReq(TypedDict):
    """Program state at a point in the trace. Delta-encoded against base_seq unless full is
    set: a whole-heap snapshot every few hundred steps would outweigh the events it
    exists to accelerate.
    """
    full: bool
    """True for a keyframe carrying complete state; false for a delta."""
    frames: list[FrameState]
    frame_order: list[int]
    """Frame ids, outermost first."""
    objects: list[ObjectState]

class StateSnapshot(_StateSnapshotReq, total=False):
    """Program state at a point in the trace. Delta-encoded against base_seq unless full is
    set: a whole-heap snapshot every few hundred steps would outweigh the events it
    exists to accelerate. (with optional members)
    """
    base_seq: int
    removed_frames: list[int]
    removed_objects: list[int]
    loops: list[LoopState]
    metrics: dict[str, int]

class _EventBase(TypedDict):
    """Required members of every event."""
    seq: int
    t: str

class EventBase(_EventBase, total=False):
    """Optional members shared by all events."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _RunStartEvent(_EventBase):
    """`run_start` — First event of every trace."""
    t: Literal["run_start"]

class RunStartEvent(_RunStartEvent, total=False):
    """`run_start` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _RunEndEvent(_EventBase):
    """`run_end` — Always emitted, including on limit breach. A truncated trace is a valid
    trace.
    """
    t: Literal["run_end"]
    status: RunStatus
    steps: int
    duration_ms: float

class RunEndEvent(_RunEndEvent, total=False):
    """`run_end` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    exit_code: int

class _StepLineEvent(_EventBase):
    """`step_line` — Execution arrived at a line. The atom of playback."""
    t: Literal["step_line"]

class StepLineEvent(_StepLineEvent, total=False):
    """`step_line` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _BranchEvent(_EventBase):
    """`branch` — A control-flow decision. outcome comes from observed execution; the
    condition is never re-evaluated, since doing so could fire side effects and change
    the program being visualized.
    """
    t: Literal["branch"]
    kind: BranchKind
    expr: str
    outcome: BranchOutcome

class BranchEvent(_BranchEvent, total=False):
    """`branch` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    target_line: int
    result: Primitive

class _LoopEnterEvent(_EventBase):
    """`loop_enter` — Opens a loop region."""
    t: Literal["loop_enter"]
    region: int
    line_start: int
    line_end: int

class LoopEnterEvent(_LoopEnterEvent, total=False):
    """`loop_enter` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _LoopIterEvent(_EventBase):
    """`loop_iter` — One iteration boundary. Basis for collapsing."""
    t: Literal["loop_iter"]
    region: int
    i: int

class LoopIterEvent(_LoopIterEvent, total=False):
    """`loop_iter` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _LoopExitEvent(_EventBase):
    """`loop_exit` — Closes a loop region."""
    t: Literal["loop_exit"]
    region: int
    iterations: int
    reason: LoopExitReason

class LoopExitEvent(_LoopExitEvent, total=False):
    """`loop_exit` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _JumpEvent(_EventBase):
    """`jump` — Non-linear control transfer."""
    t: Literal["jump"]
    kind: JumpKind

class JumpEvent(_JumpEvent, total=False):
    """`jump` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    target_line: int

class _FramePushEvent(_EventBase):
    """`frame_push` — A call began. Frame ids are unique for the whole run and never
    reused, so recursion yields a distinct frame per depth.
    """
    t: Literal["frame_push"]
    func: str
    args: list[Arg]
    kind: FrameKind
    recursion_depth: int

class FramePushEvent(_FramePushEvent, total=False):
    """`frame_push` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    caller: int

class _FramePopEvent(_EventBase):
    """`frame_pop` — A call returned."""
    t: Literal["frame_pop"]
    reason: FramePopReason

class FramePopEvent(_FramePopEvent, total=False):
    """`frame_pop` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    return_value: Value

class _VarSetEvent(_EventBase):
    """`var_set` — A variable was bound or rebound. prev is what it held before, which is
    what makes the event invertible.
    """
    t: Literal["var_set"]
    name: str
    value: Value
    scope: VarScope

class VarSetEvent(_VarSetEvent, total=False):
    """`var_set` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    prev: Value
    declared: bool

class _VarDelEvent(_EventBase):
    """`var_del` — A binding disappeared: scope exit, explicit delete, block end."""
    t: Literal["var_del"]
    name: str
    prev: Value

class VarDelEvent(_VarDelEvent, total=False):
    """`var_del` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _ObjNewEvent(_EventBase):
    """`obj_new` — A heap object came into existence."""
    t: Literal["obj_new"]
    obj: int
    kind: ObjKind
    type_name: str

class ObjNewEvent(_ObjNewEvent, total=False):
    """`obj_new` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    size: int
    addr: str
    summary: str
    length: int

class _ObjSetEvent(_EventBase):
    """`obj_set` — A slot of a heap object changed."""
    t: Literal["obj_set"]
    obj: int
    key: Primitive
    value: Value
    op: ObjSetOp

class ObjSetEvent(_ObjSetEvent, total=False):
    """`obj_set` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    prev: Value

class _ObjResizeEvent(_EventBase):
    """`obj_resize` — Bulk length change: clear, extend, array reallocation."""
    t: Literal["obj_resize"]
    obj: int
    length: int
    prev_length: int

class ObjResizeEvent(_ObjResizeEvent, total=False):
    """`obj_resize` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    cleared: list[str]
    cleared_values: list[Value]

class _ObjFreeEvent(_EventBase):
    """`obj_free` — Explicit deallocation. C/C++ only; managed languages do not report
    collection.
    """
    t: Literal["obj_free"]
    obj: int

class ObjFreeEvent(_ObjFreeEvent, total=False):
    """`obj_free` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _MemAllocEvent(_EventBase):
    """`mem_alloc` — Native allocation."""
    t: Literal["mem_alloc"]
    addr: str
    size: int
    region: MemRegion
    via: AllocVia

class MemAllocEvent(_MemAllocEvent, total=False):
    """`mem_alloc` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _MemFreeEvent(_EventBase):
    """`mem_free` — Native deallocation."""
    t: Literal["mem_free"]
    addr: str
    via: FreeVia

class MemFreeEvent(_MemFreeEvent, total=False):
    """`mem_free` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _PtrSetEvent(_EventBase):
    """`ptr_set` — A pointer was retargeted. dangling is the highest-value teaching signal
    in C: it is what draws the broken arrow explaining a use-after-free.
    """
    t: Literal["ptr_set"]
    to_addr: str
    valid: bool
    dangling: bool

class PtrSetEvent(_PtrSetEvent, total=False):
    """`ptr_set` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    name: str
    obj: int
    prev_addr: str

class _StdoutEvent(_EventBase):
    """`stdout` — Standard output, attributed to the step that produced it."""
    t: Literal["stdout"]
    text: str

class StdoutEvent(_StdoutEvent, total=False):
    """`stdout` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _StderrEvent(_EventBase):
    """`stderr` — Standard error, attributed to the step that produced it."""
    t: Literal["stderr"]
    text: str

class StderrEvent(_StderrEvent, total=False):
    """`stderr` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _StdinRequestEvent(_EventBase):
    """`stdin_request` — Execution is blocked awaiting input."""
    t: Literal["stdin_request"]

class StdinRequestEvent(_StdinRequestEvent, total=False):
    """`stdin_request` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    prompt: str

class _StdinResponseEvent(_EventBase):
    """`stdin_response` — Input that was supplied. Recorded so replay is deterministic
    without a human.
    """
    t: Literal["stdin_response"]
    text: str
    source: StdinSource

class StdinResponseEvent(_StdinResponseEvent, total=False):
    """`stdin_response` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _ExceptionRaiseEvent(_EventBase):
    """`exception_raise` — An exception was raised."""
    t: Literal["exception_raise"]
    type: str
    message: str

class ExceptionRaiseEvent(_ExceptionRaiseEvent, total=False):
    """`exception_raise` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    obj: int

class _ExceptionCatchEvent(_EventBase):
    """`exception_catch` — An exception was handled."""
    t: Literal["exception_catch"]
    handler_line: int

class ExceptionCatchEvent(_ExceptionCatchEvent, total=False):
    """`exception_catch` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _ExceptionUncaughtEvent(_EventBase):
    """`exception_uncaught` — An exception terminated the program. Terminal, but the trace
    stays replayable.
    """
    t: Literal["exception_uncaught"]
    type: str
    message: str
    stack: list[StackEntry]

class ExceptionUncaughtEvent(_ExceptionUncaughtEvent, total=False):
    """`exception_uncaught` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _MetricEvent(_EventBase):
    """`metric` — Counter increment for the metrics view."""
    t: Literal["metric"]
    name: MetricName
    delta: int

class MetricEvent(_MetricEvent, total=False):
    """`metric` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    region: int

class _StructureHintEvent(_EventBase):
    """`structure_hint` — Inferred shape of an object. Advisory, overridable, and carries
    its evidence so a wrong guess is explainable rather than mysterious.
    """
    t: Literal["structure_hint"]
    obj: int
    shape: Shape
    confidence: Confidence
    evidence: list[str]

class StructureHintEvent(_StructureHintEvent, total=False):
    """`structure_hint` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    root: bool

class _SnapshotEvent(_EventBase):
    """`snapshot` — Periodic state capture bounding how far a seek must replay."""
    t: Literal["snapshot"]
    state: StateSnapshot

class SnapshotEvent(_SnapshotEvent, total=False):
    """`snapshot` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

class _CollapseEvent(_EventBase):
    """`collapse` — A folded span of repeated loop iterations, represented as one composite
    invertible step. Carries net before/after state so folding cannot break the
    invertibility guarantee.
    """
    t: Literal["collapse"]
    region: int
    from_seq: int
    to_seq: int
    iterations: int
    effects: list[CollapseEffect]

class CollapseEvent(_CollapseEvent, total=False):
    """`collapse` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float
    metrics: dict[str, int]

class _NoteEvent(_EventBase):
    """`note` — Adapter diagnostic surfaced to the user, such as a step budget being
    reached or a frame whose locals could not be read.
    """
    t: Literal["note"]
    level: NoteLevel
    text: str

class NoteEvent(_NoteEvent, total=False):
    """`note` with optional members."""
    step: int
    frame: int
    line: int
    path: str
    ms: float

TraceEvent = Union[
    RunStartEvent,
    RunEndEvent,
    StepLineEvent,
    BranchEvent,
    LoopEnterEvent,
    LoopIterEvent,
    LoopExitEvent,
    JumpEvent,
    FramePushEvent,
    FramePopEvent,
    VarSetEvent,
    VarDelEvent,
    ObjNewEvent,
    ObjSetEvent,
    ObjResizeEvent,
    ObjFreeEvent,
    MemAllocEvent,
    MemFreeEvent,
    PtrSetEvent,
    StdoutEvent,
    StderrEvent,
    StdinRequestEvent,
    StdinResponseEvent,
    ExceptionRaiseEvent,
    ExceptionCatchEvent,
    ExceptionUncaughtEvent,
    MetricEvent,
    StructureHintEvent,
    SnapshotEvent,
    CollapseEvent,
    NoteEvent,
]
"""Any trace event, discriminated on `t`."""

EventType = Literal[
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
]

EVENT_TYPES: tuple[EventType, ...] = (
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
)

STEPPABLE_EVENT_TYPES: frozenset[str] = frozenset({
    "step_line",
    "branch",
    "jump",
    "frame_push",
    "frame_pop",
    "exception_raise",
    "exception_catch",
    "collapse",
})
"""Event types a user can land on when stepping. Other events mutate state or carry
bookkeeping, and are applied while passing over them.
"""

class Trace(TypedDict):
    """A complete trace: header plus events. Shape of a saved trace file."""
    schema: str
    session: Session
    events: list[TraceEvent]
