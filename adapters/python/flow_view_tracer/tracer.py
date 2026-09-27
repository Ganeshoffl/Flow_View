"""The Python tracer.

Runs a program under ``sys.settrace`` and emits a Universal Trace. Pure Python with no dependencies,
so the identical module runs in a CPython subprocess for the Full profile and inside Pyodide for the
Lite profile.

## How each step is handled

A ``line`` event arrives. The tracer then, in order:

1. asks the pre-computed analysis what this line can do;
2. resolves any branch left pending from the previous line, by observing where control actually went;
3. diffs the frame's locals and emits ``var_set`` for what moved;
4. walks the heap — but only if the line could mutate it, and only from the names the line mentions.

Step 4 is the expensive one, and steps 1 and 4 together are why it is usually skipped. See
``docs/decisions/0001-reading-the-python-heap.md``.

## What is deliberately not done

**Conditions are never re-evaluated.** A branch's outcome comes from which line ran next, not from
asking Python for the value of the test. ``if queue.pop():`` must not run twice, and a tracer that
changes the program it is observing is worse than no tracer.

**Library internals are not entered.** Frames from outside the user's file are announced as opaque
calls with their arguments and return value, and their interiors are suppressed with
``f_trace_lines = False`` so no per-line cost is paid inside them.
"""

from __future__ import annotations

import os
import sys
from types import FrameType
from typing import Any, Callable

from .analysis import LineInfo, SourceAnalysis, analyze
from .backends import choose_backend
from .emit import BudgetExceeded, Emitter, Limits, encode_primitive, encode_value
from .walk import (
    DEFAULT_MAX_DEPTH,
    DEFAULT_MAX_OBJECTS,
    DEFAULT_MAX_SLOTS,
    Registry,
    Slots,
    classify,
    diff_snapshots,
    is_atomic,
    walk_bounded,
)

__all__ = ["Tracer", "TracerOptions", "run_path", "run_source"]

ADAPTER_VERSION = "0.1.0"

#: The tracer's own modules. Frames from these are never traced, so flow_view cannot appear in its
#: own output.
_INTERNAL_MODULES = (
    "flow_view_tracer.tracer",
    "flow_view_tracer.emit",
    "flow_view_tracer.walk",
    "flow_view_tracer.analysis",
    # backends must be here: uninstall() necessarily runs while tracing is still active, so without
    # it the tracer records its own teardown — a frame for `uninstall` and a heap object for the
    # backend appeared at the end of every trace.
    "flow_view_tracer.backends",
    "flow_view_tracer.guards",
    "flow_view_tracer.cli",
)


class TracerOptions:
    """Knobs for one run."""

    __slots__ = (
        "max_depth",
        "max_objects",
        "max_slots",
        "complete_heap",
        "emit_metrics",
        "session_id",
        "backend",
    )

    def __init__(
        self,
        *,
        max_depth: int = DEFAULT_MAX_DEPTH,
        max_objects: int = DEFAULT_MAX_OBJECTS,
        max_slots: int | None = DEFAULT_MAX_SLOTS,
        complete_heap: bool = False,
        emit_metrics: bool = True,
        session_id: str = "local",
        backend: str = "auto",
    ) -> None:
        self.max_depth = max_depth
        self.max_objects = max_objects
        self.max_slots = max_slots
        # An explicit "show me everything" mode. Correct at any size, affordable only when small.
        self.complete_heap = complete_heap
        self.emit_metrics = emit_metrics
        self.session_id = session_id
        # auto, settrace or monitoring. Forcing one is how the conformance suite proves the two
        # mechanisms produce the same trace.
        self.backend = backend


class _OpenLoop:
    """A loop region currently running in a frame."""

    __slots__ = ("region", "line_start", "line_end", "iterations")

    def __init__(self, region: int, line_start: int, line_end: int) -> None:
        self.region = region
        self.line_start = line_start
        self.line_end = line_end
        self.iterations = 0

    def contains(self, line: int) -> bool:
        return self.line_start <= line <= self.line_end


class _FrameState:
    """Per-frame bookkeeping."""

    __slots__ = (
        "frame_id",
        "locals_snapshot",
        "pending_branch",
        "pending_line",
        "previous_line",
        "depth",
        "loops",
        "pending_jump",
        "kind",
    )

    def __init__(self, frame_id: int, depth: int, kind: str = "user") -> None:
        self.frame_id = frame_id
        #: Schema FrameKind. Library frames are announced but their interiors are never stepped.
        self.kind = kind
        self.locals_snapshot: dict[str, Any] = {}
        #: A branch whose outcome is not yet known, waiting on the next line event.
        self.pending_branch: tuple[LineInfo, int] | None = None
        self.pending_line = 0
        #: The line that ran before the current one. State changes observed now were caused there,
        #: so that is the line they are attributed to.
        self.previous_line = 0
        self.depth = depth
        #: Loop regions open in this frame, innermost last.
        self.loops: list[_OpenLoop] = []
        #: Set when a break or continue has just executed, so a loop exit can name its cause.
        self.pending_jump: str | None = None


def _summarize(obj: Any) -> str | None:
    """A short label for an object, where one can be produced safely.

    Calling an arbitrary ``__repr__`` runs arbitrary code — including, in the worst case, code that
    mutates the object being described. So this is limited to things that can be named without
    executing anything (functions, classes, modules) and to user classes that defined ``__repr__``
    themselves. Anything that raises is skipped rather than reported.
    """
    import types as _types

    if isinstance(obj, (_types.FunctionType, _types.BuiltinFunctionType, _types.MethodType)):
        name = getattr(obj, "__qualname__", None) or getattr(obj, "__name__", "function")
        return f"{name}()"
    if isinstance(obj, type):
        return f"class {obj.__name__}"
    if isinstance(obj, _types.ModuleType):
        return f"module {getattr(obj, '__name__', '?')}"

    cls = type(obj)
    if cls.__module__ in ("builtins", "__builtin__"):
        return None
    if "__repr__" not in cls.__dict__:
        return None
    try:
        text = repr(obj)
    except Exception:
        return None
    return text[:120] if text else None


def _values_differ(before: Any, after: Any) -> bool:
    """Whether a binding changed, by value for atomics and by identity for everything else.

    Identity alone is wrong: ``n = 1000`` twice produces two objects holding the same number, and
    reporting that as a change would litter the trace with assignments that changed nothing. Value
    alone is also wrong: two equal lists are two different objects, and a rebinding between them is a
    real change the heap view must show.
    """
    if before is after:
        return False
    if is_atomic(before) and is_atomic(after):
        if type(before) is not type(after):
            return True
        try:
            return bool(before != after)
        except Exception:
            return True
    return True


class Tracer:
    """Traces one program."""

    def __init__(
        self,
        source: str,
        path: str,
        emitter: Emitter,
        options: TracerOptions | None = None,
    ) -> None:
        self.source = source
        self.path = os.path.abspath(path)
        # Events carry a short name, not the absolute path. The server runs each program from a fresh
        # temporary directory, so the absolute path is a meaningless string like
        # /tmp/flow_view_run_tmxcriwu/main.py — which is what the UI was showing as a file heading.
        # The full path is still used for file identity and for compiling.
        self.display_path = os.path.basename(self.path)
        self.emitter = emitter
        self.options = options or TracerOptions()
        self.analysis: SourceAnalysis = analyze(self.path, source)

        self._root_code: Any = None
        self._registry = Registry(on_new=self._announce)
        self._immutable_cache: dict[int, Slots] = {}
        self._heap: Slots = {}
        self._frames: dict[int, _FrameState] = {}
        self._frame_stack: list[_FrameState] = []
        self._next_frame_id = 0
        self._next_region_id = 1
        self._recursion: dict[str, int] = {}
        self._announced: set[int] = set()
        #: Identity of the exception currently propagating, if any. Held so that the same exception
        #: passing through five frames is reported once as a raise, not five times.
        self._active_exception: int | None = None
        #: True while an exception is unwinding, so frame pops can be attributed to it.
        self._unwinding = False
        self._budget_hit = False
        self._metrics_enabled = self.options.emit_metrics

        # Reentrancy guard. The tracer's own code can be called *from* the traced program — `print`
        # reaches the output proxy, `input` reaches the stdin bridge — and settrace fires on those
        # frames like any other. Without this the trace fills with flow_view's internals, and the
        # object registry fills with flow_view's own objects.
        self._muted = False
        self._internal_files = frozenset(
            os.path.abspath(module.__file__)
            for module in (sys.modules.get(name) for name in _INTERNAL_MODULES)
            if module is not None and getattr(module, "__file__", None)
        )

    # -- helpers -----------------------------------------------------------

    @property
    def _current(self) -> _FrameState | None:
        return self._frame_stack[-1] if self._frame_stack else None

    def _current_ids(self) -> tuple[int | None, int | None]:
        frame = self._current
        return (frame.frame_id, frame.pending_line) if frame else (None, None)

    def _is_user_file(self, filename: str) -> bool:
        try:
            return os.path.abspath(filename) == self.path
        except Exception:
            return False

    def _metric(self, name: str, delta: int = 1) -> None:
        if self._metrics_enabled:
            self.emitter.emit("metric", {"name": name, "delta": delta})

    # -- heap --------------------------------------------------------------

    def _announce(self, obj_id: int, obj: Any) -> None:
        """Introduce an object the first time it is given an id.

        Wired into the registry, so every path that can produce a reference announces the object
        first — the walk visiting it, the walk referencing it beyond a depth limit, or the tracer
        encoding a variable's value.
        """
        from .walk import _length_of  # noqa: PLC0415 - private to walk

        payload: dict[str, Any] = {
            "obj": obj_id,
            "kind": classify(obj),
            "type_name": type(obj).__name__,
        }
        length = _length_of(obj)
        if length is not None:
            payload["length"] = length
        summary = _summarize(obj)
        if summary is not None:
            payload["summary"] = summary
        self.emitter.emit("obj_new", payload)
        self._metric("allocation")

    def _walk_from(self, roots: list[tuple[str, Any]]) -> None:
        """Read the heap from the given roots and emit whatever changed."""
        if self.options.complete_heap:
            from .walk import walk_full

            result = walk_full(
                roots, self._registry, immutable_cache=self._immutable_cache
            )
        else:
            result = walk_bounded(
                roots,
                self._registry,
                max_depth=self.options.max_depth,
                max_objects=self.options.max_objects,
                max_slots=self.options.max_slots,
                immutable_cache=self._immutable_cache,
            )

        state = self._current
        frame_id = state.frame_id if state else None
        # Attributed to the line that caused the change, not the one we noticed it on.
        line = (state.previous_line or state.pending_line) if state else None

        def emit_mutation(kind: str, payload: dict[str, Any]) -> None:
            event: dict[str, Any] = {
                "obj": payload["obj"],
                "key": payload["key"],
                "value": encode_value(payload["value"]),
                "op": payload["op"],
            }
            if "prev" in payload:
                event["prev"] = encode_value(payload["prev"])
            if frame_id is not None:
                event["frame"] = frame_id
            if line:
                event["line"] = line
            self.emitter.emit(kind, event)
            self._metric("write")

        # Only the objects this walk actually looked at may be compared. Anything outside its region
        # is unexamined, not unchanged, and must not be diffed against a stale reading.
        previous = {obj_id: self._heap[obj_id] for obj_id in result.slots if obj_id in self._heap}
        diff_snapshots(previous, result.slots, emit_mutation)
        self._heap.update(result.slots)

        if result.truncated:
            self.emitter.note(
                "info",
                "Part of the heap is beyond the inspection limits, so the object view is "
                "incomplete for some steps. Values shown are accurate; some are not expanded.",
            )

    def _roots_for(self, frame: FrameType, info: LineInfo | None) -> list[tuple[str, Any]]:
        """Walk roots for a line: the names it mentions, resolved in this frame.

        Falling back to every local when the line is unknown is deliberate. A line the analysis
        could not classify might touch anything, and missing a mutation is worse than a slow step.
        """
        frame_locals = frame.f_locals
        if info is None:
            return [
                (name, value)
                for name, value in frame_locals.items()
                if not is_atomic(value)
            ]

        roots: list[tuple[str, Any]] = []
        globals_ = frame.f_globals
        for name in info.names:
            if name in frame_locals:
                value = frame_locals[name]
            elif name in globals_:
                value = globals_[name]
            else:
                continue
            if not is_atomic(value):
                roots.append((name, value))
        return roots

    # -- variables ---------------------------------------------------------

    def _diff_locals(self, frame: FrameType, state: _FrameState) -> list[tuple[str, Any]]:
        """Emit ``var_set`` for what moved, and report newly bound objects.

        The returned bindings are walked even when the line could not *mutate* anything, because
        creating a container is not mutation. Without this, ``first = [1, 2, 3]`` would announce the
        list but not its contents, and they would appear later attributed to whichever line first
        happened to trigger a walk — so stepping to line 2 would show an empty list.
        """
        current = frame.f_locals
        previous = state.locals_snapshot
        frame_id = state.frame_id
        line = state.previous_line or state.pending_line
        fresh: list[tuple[str, Any]] = []

        for name, value in current.items():
            if name.startswith("__") and name.endswith("__"):
                continue
            had = name in previous
            if had and not _values_differ(previous[name], value):
                continue
            if not is_atomic(value):
                fresh.append((name, value))

            payload: dict[str, Any] = {
                "frame": frame_id,
                "name": name,
                "value": self._encode(value),
                "scope": "local",
            }
            if line:
                payload["line"] = line
            if had:
                payload["prev"] = self._encode(previous[name])
            else:
                payload["declared"] = True
            self.emitter.emit("var_set", payload)
            self._metric("assignment")

        for name in list(previous):
            if name not in current and not (name.startswith("__") and name.endswith("__")):
                self.emitter.emit(
                    "var_del",
                    {"frame": frame_id, "name": name, "prev": self._encode(previous[name])},
                )

        state.locals_snapshot = dict(current)
        return fresh

    def _encode(self, value: Any) -> dict[str, Any]:
        """Encode a live Python value as a schema value.

        Functions, classes and modules become heap objects like anything else, rather than the string
        ``"<function>"``. Rendering a function as a string made the variables pane report its type as
        ``str``, which is simply false. The walk still refuses to descend into them, so they appear as
        named objects with no contents — shown, but not expanded.
        """
        if is_atomic(value):
            return encode_primitive(value)
        return {"ref": self._registry.id_for(value)}

    # -- branches ----------------------------------------------------------

    def _resolve_branch(self, state: _FrameState, arrived_at: int) -> None:
        """Decide a pending branch from where control actually went."""
        pending = state.pending_branch
        if pending is None:
            return
        state.pending_branch = None
        info, _ = pending
        branch = info.branch
        if branch is None:
            return

        taken = arrived_at == branch.body_line
        payload: dict[str, Any] = {
            "frame": state.frame_id,
            "line": info.line,
            "kind": branch.kind,
            "expr": branch.expr,
            "outcome": "taken" if taken else "not_taken",
            "target_line": arrived_at,
        }
        self.emitter.emit("branch", payload)
        if branch.kind in ("if", "elif", "while"):
            self._metric("comparison")

        if info.is_loop_header and info.loop is not None:
            self._handle_loop(state, info, taken)

    def _handle_loop(self, state: _FrameState, info: LineInfo, entering: bool) -> None:
        existing = next((loop for loop in state.loops if loop.line_start == info.line), None)

        if entering:
            if existing is None:
                region = self._next_region_id
                self._next_region_id += 1
                start = info.loop.line_start if info.loop else info.line
                end = info.loop.line_end if info.loop else info.line
                existing = _OpenLoop(region, start, end)
                state.loops.append(existing)
                self.emitter.emit(
                    "loop_enter",
                    {
                        "frame": state.frame_id,
                        "region": region,
                        "line_start": start,
                        "line_end": end,
                    },
                )
            self.emitter.emit(
                "loop_iter",
                {"frame": state.frame_id, "region": existing.region, "i": existing.iterations},
            )
            existing.iterations += 1
            self._metric("iteration")
        elif existing is not None:
            self._close_loop(state, existing, "condition")

    def _close_loop(self, state: _FrameState, loop: _OpenLoop, reason: str) -> None:
        self.emitter.emit(
            "loop_exit",
            {
                "frame": state.frame_id,
                "region": loop.region,
                "iterations": loop.iterations,
                "reason": reason,
            },
        )
        if loop in state.loops:
            state.loops.remove(loop)

    def _close_escaped_loops(self, state: _FrameState, line: int) -> None:
        """Close any loop whose body no longer contains execution.

        A loop that ends by its condition failing is caught by the header's branch outcome. A loop
        left by ``break``, or by a ``return`` from inside it, never re-evaluates its header — so
        without this the region would stay open forever and the trace would claim the loop is still
        running.
        """
        reason = state.pending_jump or "condition"
        for loop in list(state.loops):
            if not loop.contains(line):
                self._close_loop(state, loop, "break" if reason == "break" else "condition")

    # -- trace callbacks ---------------------------------------------------

    @property
    def known_frames(self) -> dict[int, _FrameState]:
        """Frames the tracer accepted, keyed by frame identity."""
        return self._frames

    def wants_lines(self, frame: FrameType) -> bool:
        """Whether line events inside this frame are of any interest.

        They are not, for library code. ``settrace`` is told via ``f_trace_lines = False``, which
        monitoring ignores entirely — so monitoring was stepping through the json module while
        settrace was not. A backend asks here instead of assuming.
        """
        state = self._frames.get(id(frame))
        return state is not None and state.kind != "library"

    def in_scope(self, frame: FrameType) -> bool:
        """Whether a newly entered frame belongs to the program being traced.

        ``settrace`` is installed at a point in the stack and therefore only ever sees frames below
        it. ``sys.monitoring`` is global: without this, it reports every function in the process —
        the caller that started the run, the test harness, the innards of every imported module.
        Roughly two thousand events instead of nineteen.

        A frame is in scope when it *is* the program's module frame, or when its caller already is.
        """
        if frame.f_code is self._root_code:
            return True
        caller = frame.f_back
        return caller is not None and id(caller) in self._frames

    def ignores(self, frame: FrameType) -> bool:
        """Whether this frame must not be traced at all.

        Covers the tracer's own modules and anything reached while muted. Both backends consult it,
        so neither can let flow_view appear in its own output.
        """
        return (
            self._muted
            or self.emitter.stopped
            or frame.f_code.co_filename in self._internal_files
        )

    # -- settrace adapter --------------------------------------------------

    def _trace(self, frame: FrameType, event: str, arg: Any) -> Callable[..., Any] | None:
        """The ``sys.settrace`` protocol, delegating to the shared handlers."""
        if self.ignores(frame):
            return None
        try:
            if event == "call":
                self.handle_call(frame)
            elif event == "line":
                self.handle_line(frame)
            elif event == "return":
                self.handle_return(frame, arg)
            elif event == "exception":
                self.handle_raise(frame, arg[0], arg[1])
        except BudgetExceeded:
            raise
        return self._trace

    def handle_call(self, frame: FrameType) -> bool:
        """A frame was entered. Returns whether its interior should be traced."""
        user = self._is_user_file(frame.f_code.co_filename)
        name = frame.f_code.co_name

        if not user:
            # An opaque library call: announced with its arguments, its interior suppressed. No
            # per-line cost is paid inside it, which is the point.
            self._push(frame, name, kind="library")
            frame.f_trace_lines = False
            return False

        self._push(frame, name, kind="user")
        return True

    def _push(self, frame: FrameType, name: str, *, kind: str) -> int:
        frame_id = self._next_frame_id
        self._next_frame_id += 1
        depth = self._recursion.get(name, 0)
        self._recursion[name] = depth + 1

        state = _FrameState(frame_id, depth, kind)
        # At a module's call event f_lineno is 0, which is not a line anyone can point at.
        state.pending_line = frame.f_lineno or 1
        self._frames[id(frame)] = state
        self._frame_stack.append(state)

        args: list[dict[str, Any]] = []
        code = frame.f_code
        count = code.co_argcount + getattr(code, "co_kwonlyargcount", 0)
        for arg_name in code.co_varnames[:count]:
            if arg_name in frame.f_locals:
                args.append({"name": arg_name, "value": self._encode(frame.f_locals[arg_name])})

        caller = self._frame_stack[-2].frame_id if len(self._frame_stack) > 1 else None
        payload: dict[str, Any] = {
            "frame": frame_id,
            "func": name,
            "args": args,
            "kind": kind,
            "recursion_depth": depth,
            "line": state.pending_line,
        }
        if caller is not None:
            payload["caller"] = caller
        if kind == "user":
            payload["path"] = self.display_path
        self.emitter.emit("frame_push", payload)
        self._metric("call")

        state.locals_snapshot = dict(frame.f_locals)
        return frame_id

    def handle_line(self, frame: FrameType) -> None:
        """A line is about to execute."""
        state = self._frames.get(id(frame))
        if state is None:
            return

        line = frame.f_lineno
        self.emitter.check_budget()

        # Running again while an exception is in flight means a handler caught it.
        self._note_handled(state, line)

        self._resolve_branch(state, line)
        self._close_escaped_loops(state, line)
        state.pending_jump = None

        # Whatever changed since the last line event was caused by the line that ran then, so that
        # is the line the resulting events are attributed to. Blaming the line we have merely
        # arrived at would show `total` changing while the `for` header is highlighted.
        state.previous_line = state.pending_line or line
        state.pending_line = line
        info = self.analysis.at(line)

        self.emitter.emit(
            "step_line", {"frame": state.frame_id, "line": line, "path": self.display_path}
        )

        fresh = self._diff_locals(frame, state)

        # The heap is only read when the line could have changed it, which is the saving the
        # benchmark identified as the cheapest and largest available. Newly bound objects are read
        # regardless, since construction is not mutation.
        previous_info = self.analysis.at(state.previous_line)
        roots = list(fresh)
        if previous_info is None or previous_info.may_mutate:
            roots.extend(self._roots_for(frame, previous_info))
        if roots:
            self._walk_from(roots)

        if info is not None and info.jump is not None:
            state.pending_jump = info.jump
            self.emitter.emit(
                "jump", {"frame": state.frame_id, "line": line, "kind": info.jump}
            )

        if info is not None and info.branch is not None:
            # Decided on the next line event, by observing where control went.
            state.pending_branch = (info, line)

    def handle_return(self, frame: FrameType, value: Any) -> None:
        """A frame is exiting, by return or by an exception passing through it."""
        state = self._frames.pop(id(frame), None)
        if state is None:
            return

        # Observe what the frame's last line did.
        #
        # Changes are normally noticed at the *following* line event, which the last line of a frame
        # never gets. Without this, `items.append(x)` as a program's final statement would leave no
        # trace of the append at all.
        if not self._unwinding:
            state.previous_line = state.pending_line
            fresh = self._diff_locals(frame, state)
            last = self.analysis.at(state.pending_line)
            roots = list(fresh)
            if last is None or last.may_mutate:
                roots.extend(self._roots_for(frame, last))
            if roots:
                self._walk_from(roots)

        # Work out why any still-open loop ended, before discarding the evidence.
        #
        # A loop that is the last thing in a frame never gets a following line event, so it is closed
        # here rather than by _close_escaped_loops. The cause has to be reconstructed: a break just
        # executed, an exception in flight, or the header condition having failed — which is what a
        # pending branch on the loop header means.
        pending = state.pending_branch
        reason = "return"
        if state.pending_jump == "break":
            reason = "break"
        elif self._unwinding:
            reason = "exception"
        elif pending is not None and pending[0].is_loop_header:
            reason = "condition"

        state.pending_branch = None
        for loop in list(state.loops):
            self._close_loop(state, loop, reason)

        if self._frame_stack and self._frame_stack[-1] is state:
            self._frame_stack.pop()

        name = frame.f_code.co_name
        self._recursion[name] = max(0, self._recursion.get(name, 1) - 1)

        payload: dict[str, Any] = {
            "frame": state.frame_id,
            "reason": "exception" if self._unwinding else "return",
            "line": frame.f_lineno,
        }
        if not self._unwinding:
            payload["return_value"] = self._encode(value)
        self.emitter.emit("frame_pop", payload)

    def handle_raise(self, frame: FrameType, exc_type: type, exc_value: BaseException) -> None:
        """An exception appeared in this frame, whether raised here or passing through."""
        if isinstance(exc_type, type) and issubclass(exc_type, BudgetExceeded):
            # The tracer's own stop signal. Reporting it would show the user an error their program
            # never raised.
            return

        self._unwinding = True

        # settrace fires an exception event in every frame the exception passes through. Only the
        # first is a raise; the rest are the same exception still travelling, and reporting each as
        # a new raise would claim the program failed five times instead of once.
        identity = id(exc_value)
        if self._active_exception == identity:
            return
        self._active_exception = identity

        state = self._frames.get(id(frame))
        payload: dict[str, Any] = {
            "type": exc_type.__name__,
            "message": str(exc_value),
            "line": frame.f_lineno,
            "path": self.display_path,
        }
        if state is not None:
            payload["frame"] = state.frame_id
        self.emitter.emit("exception_raise", payload)

    def _note_handled(self, state: _FrameState, line: int) -> None:
        """Record that a propagating exception was caught here.

        A line event while an exception is in flight means the program is running again, which in
        Python means control reached an ``except`` clause. Without this the unwinding flag would stay
        set for the rest of the run, and every later return would be misreported as an exception with
        its return value discarded.
        """
        if self._active_exception is None:
            return
        self._active_exception = None
        self._unwinding = False
        self.emitter.emit(
            "exception_catch",
            {
                "frame": state.frame_id,
                "line": line,
                "path": self.display_path,
                "handler_line": line,
            },
        )

    # -- running -----------------------------------------------------------

    def session_header(self) -> dict[str, Any]:
        import hashlib
        from datetime import datetime, timezone

        digest = hashlib.sha256(self.source.encode("utf-8")).hexdigest()
        return {
            "id": self.options.session_id,
            "language": "python",
            "language_version": ".".join(str(part) for part in sys.version_info[:3]),
            "adapter_version": ADAPTER_VERSION,
            "profile": "full",
            "source_files": [
                {
                    "path": os.path.basename(self.path),
                    "sha256": digest,
                    "line_count": self.analysis.line_count(),
                }
            ],
            "entry": {"path": os.path.basename(self.path), "line": 1},
            "limits": self.emitter.limits.as_dict(),
            "started_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }

    def run(self) -> str:
        """Execute the program under trace. Returns the schema ``RunStatus``."""
        if self.analysis.syntax_error:
            self.emitter.emit("run_start")
            self.emitter.note("warn", f"Could not parse the program: {self.analysis.syntax_error}")
            self.emitter.emit(
                "run_end",
                {"status": "error", "exit_code": 1, "steps": self.emitter.step, "duration_ms": 0.0},
            )
            self.emitter.seal()
            return "error"

        module_globals: dict[str, Any] = {
            "__name__": "__main__",
            "__file__": self.path,
            "__builtins__": __builtins__,
        }
        code = compile(self.source, self.path, "exec")

        self.emitter.emit("run_start")
        status = "ok"
        exit_code = 0

        original_stdout, original_stderr = sys.stdout, sys.stderr
        sys.stdout = _OutputProxy(self, "stdout", original_stdout)
        sys.stderr = _OutputProxy(self, "stderr", original_stderr)

        import builtins as _builtins

        original_input = _builtins.input
        _builtins.input = _InputBridge(self, sys.stdin)  # type: ignore[assignment]

        # The code object the program itself runs as. Monitoring is global rather than per-frame, so
        # this is how a backend recognises the root of what it should be watching; settrace gets that
        # scoping for free from where it was installed.
        self._root_code = code

        backend = choose_backend(self.options.backend)
        try:
            backend.install(self)
            try:
                exec(code, module_globals)
            finally:
                # Teardown runs while tracing is still live, so it is muted as well as excluded by
                # filename. Belt and braces, because this leaked once already.
                self._muted = True
                backend.uninstall()
                self._muted = False
        except BudgetExceeded as stop:
            status = stop.reason
            exit_code = 0
        except SystemExit as stop:
            exit_code = int(stop.code) if isinstance(stop.code, int) else 0
            status = "ok" if exit_code == 0 else "error"
        except BaseException as error:  # noqa: BLE001 - the program's failure is a result
            status = "error"
            exit_code = 1
            self._report_uncaught(error)
        finally:
            sys.stdout, sys.stderr = original_stdout, original_stderr
            _builtins.input = original_input
            self._close_open_frames()

        self.emitter.emit(
            "run_end",
            {
                "status": status,
                "exit_code": exit_code,
                "steps": self.emitter.step,
                "duration_ms": round(self.emitter.elapsed_ms(), 3),
            },
        )
        self.emitter.seal()
        return status

    def _report_uncaught(self, error: BaseException) -> None:
        import traceback

        # Only the user's own frames belong in the traceback. The tracer sits between the
        # interpreter and the program, so its `run` frame appears at the top of every traceback —
        # showing it would present flow_view's internals as part of the user's failure.
        entries = [
            entry
            for entry in traceback.extract_tb(error.__traceback__)
            if os.path.abspath(entry.filename or "") not in self._internal_files
        ]
        stack = [
            {
                "func": entry.name,
                "path": os.path.basename(entry.filename or self.path),
                "line": entry.lineno or 0,
            }
            for entry in entries
        ]
        self.emitter.emit(
            "exception_uncaught",
            {"type": type(error).__name__, "message": str(error), "stack": stack},
        )

        # The rendered traceback is filtered the same way, so what reaches stderr is what Python
        # would have printed had flow_view not been in the call chain.
        rendered = ["Traceback (most recent call last):\n"]
        rendered.extend(traceback.format_list(entries))
        rendered.extend(traceback.format_exception_only(type(error), error))
        self.emitter.output("stderr", "".join(rendered), None, None)

    def _close_open_frames(self) -> None:
        """Balance any frames left open, so the trace satisfies its invariants.

        A run stopped by a budget unwinds without ``return`` events. The trace still has to be
        replayable, and a replayable trace has balanced frames.
        """
        while self._frame_stack:
            state = self._frame_stack.pop()
            self.emitter.emit(
                "frame_pop",
                {"frame": state.frame_id, "reason": "implicit", "line": state.pending_line},
            )
        self._frames.clear()


class _InputBridge:
    """Replaces ``input`` so reads become part of the trace.

    Two things are recorded: that the program asked, and what it got. The answer matters as much as
    the question — with it, a saved trace replays identically with no human present, which is what
    makes an interactive run reviewable afterwards.

    The prompt is carried on the request rather than written to stdout, where the real ``input``
    would put it. A prompt is not program output; it is a question, and the UI needs to show it as
    one rather than as a stray line of text.

    Phase 1 records input supplied up front. Phase 5 adds the blocking round trip to the browser;
    this is the half that makes a trace deterministic, and it is needed either way.
    """

    def __init__(self, tracer: Tracer, stdin: Any) -> None:
        self._tracer = tracer
        self._stdin = stdin

    def __call__(self, prompt: object = "") -> str:
        tracer = self._tracer
        frame_id, line = tracer._current_ids()  # noqa: SLF001 - same package
        text = "" if prompt is None else str(prompt)

        tracer._muted = True  # noqa: SLF001 - same package
        try:
            payload: dict[str, Any] = {}
            if frame_id is not None:
                payload["frame"] = frame_id
            if line:
                payload["line"] = line
            if text:
                payload["prompt"] = text
            tracer.emitter.emit("stdin_request", payload)
        finally:
            tracer._muted = False  # noqa: SLF001 - same package

        supplied = self._stdin.readline()
        if supplied == "":
            # No more input. Raising EOFError is what real `input` does, so the program behaves as it
            # would outside flow_view.
            tracer._muted = True  # noqa: SLF001 - same package
            try:
                tracer.emitter.note(
                    "warn", "The program asked for input but none was left to give."
                )
            finally:
                tracer._muted = False  # noqa: SLF001 - same package
            raise EOFError("no input available")

        answer = supplied.rstrip("\n")
        tracer._muted = True  # noqa: SLF001 - same package
        try:
            tracer.emitter.emit(
                "stdin_response", {"text": answer, "source": "prefilled"}
            )
        finally:
            tracer._muted = False  # noqa: SLF001 - same package
        return answer


class _OutputProxy:
    """Captures program output and attributes it to the step that produced it."""

    def __init__(self, tracer: Tracer, stream_name: str, original: Any) -> None:
        self._tracer = tracer
        self._name = stream_name
        self._original = original

    def write(self, text: str) -> int:
        if text:
            tracer = self._tracer
            # Muted for the duration: this method is called from inside the traced program, and
            # everything it touches would otherwise be traced as if the program had written it.
            tracer._muted = True  # noqa: SLF001 - same package
            try:
                frame_id, line = tracer._current_ids()  # noqa: SLF001 - same package
                tracer.emitter.output(self._name, text, frame_id, line)
            finally:
                tracer._muted = False  # noqa: SLF001 - same package
        return len(text)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return False

    @property
    def encoding(self) -> str:
        return getattr(self._original, "encoding", "utf-8")

    def writelines(self, lines: Any) -> None:
        for line in lines:
            self.write(line)

    def fileno(self) -> int:
        # Some libraries ask. Raising the standard error is more honest than handing back a real
        # descriptor that would bypass capture entirely.
        raise OSError("flow_view captures this stream")


# ---------------------------------------------------------------------------
# entry points
# ---------------------------------------------------------------------------


def run_source(
    source: str,
    path: str = "main.py",
    *,
    stream: Any = None,
    on_event: Callable[[dict[str, Any]], None] | None = None,
    limits: Limits | None = None,
    options: TracerOptions | None = None,
) -> str:
    """Trace a program given as text. Emits the session header, then the events."""
    emitter = Emitter(stream, limits=limits, on_event=on_event)
    tracer = Tracer(source, path, emitter, options)
    header = {"schema": "flow_view/trace@1", "session": tracer.session_header()}
    if on_event is not None:
        on_event(header)
    elif stream is not None:
        import json

        stream.write(json.dumps(header, separators=(",", ":")))
        stream.write("\n")
    return tracer.run()


def run_path(path: str, **kwargs: Any) -> str:
    """Trace a program on disk."""
    with open(path, encoding="utf-8") as handle:
        return run_source(handle.read(), path, **kwargs)
