"""How the tracer is notified that something happened.

Two mechanisms, one set of handlers. ``sys.settrace`` works everywhere including Pyodide;
``sys.monitoring`` (PEP 669) is cheaper and exists from Python 3.12.

The split is deliberately thin. Each backend translates its own protocol into calls on the tracer and
does nothing else — no interpretation, no decisions about what an event means. Two backends that each
decided for themselves what a return was would eventually disagree, and a user would get a different
trace depending on which Python they happened to have. The conformance suite runs the whole corpus
through both and asserts the event streams are identical.

## Why monitoring is faster

``settrace`` calls back on every line of every frame it is attached to. Monitoring lets a callback
answer ``DISABLE`` for a location it never wants to hear about again, which is exactly the situation
inside library code: the boundary is decided once instead of being re-checked on every line of the
json module.
"""

from __future__ import annotations

import sys
from types import FrameType
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .tracer import Tracer

__all__ = ["Backend", "MonitoringBackend", "SettraceBackend", "choose_backend", "monitoring_available"]


class Backend(Protocol):
    """Installs and removes a notification mechanism."""

    name: str

    def install(self, tracer: Tracer) -> None: ...

    def uninstall(self) -> None: ...


def monitoring_available() -> bool:
    """Whether ``sys.monitoring`` can be used here."""
    return sys.version_info >= (3, 12) and hasattr(sys, "monitoring")


class SettraceBackend:
    """The portable mechanism. Works on every supported version, and inside Pyodide."""

    name = "settrace"

    def install(self, tracer: Tracer) -> None:
        sys.settrace(tracer._trace)  # noqa: SLF001 - the backend is part of the tracer

    def uninstall(self) -> None:
        sys.settrace(None)


class MonitoringBackend:
    """The cheaper mechanism, from Python 3.12.

    Monitoring is global rather than per-frame, so every callback has to establish which frame it is
    talking about and whether that frame is any of our business. ``sys._getframe(1)`` gives the
    monitored frame — verified, not assumed — and frames belonging to the tracer or to library code
    are refused, in library code's case permanently via ``DISABLE``.
    """

    name = "monitoring"

    #: Tool ids 0-5 are reserved for specific purposes; 2 is the profiler slot, which is the closest
    #: match for what this is and is not used by debuggers.
    TOOL_ID = 2

    def __init__(self) -> None:
        self._tracer: Tracer | None = None
        self._installed = False

    def install(self, tracer: Tracer) -> None:
        if not monitoring_available():  # pragma: no cover - guarded by choose_backend
            raise RuntimeError("sys.monitoring needs Python 3.12 or newer")

        self._tracer = tracer
        mon = sys.monitoring
        events = mon.events

        mon.use_tool_id(self.TOOL_ID, "flow_view")
        mon.register_callback(self.TOOL_ID, events.PY_START, self._on_start)
        mon.register_callback(self.TOOL_ID, events.LINE, self._on_line)
        mon.register_callback(self.TOOL_ID, events.PY_RETURN, self._on_return)
        mon.register_callback(self.TOOL_ID, events.PY_UNWIND, self._on_unwind)
        mon.register_callback(self.TOOL_ID, events.RAISE, self._on_raise)
        # A generator that yields is, to settrace, a frame returning — and resuming is a fresh call.
        # Monitoring reports suspension and resumption separately, so both are mapped onto the same
        # handlers to keep the two event streams identical.
        mon.register_callback(self.TOOL_ID, events.PY_YIELD, self._on_return)
        mon.register_callback(self.TOOL_ID, events.PY_RESUME, self._on_resume)
        mon.set_events(
            self.TOOL_ID,
            events.PY_START
            | events.LINE
            | events.PY_RETURN
            | events.PY_UNWIND
            | events.PY_YIELD
            | events.PY_RESUME
            | events.RAISE,
        )
        self._installed = True

    def uninstall(self) -> None:
        if not self._installed:
            return
        mon = sys.monitoring
        mon.set_events(self.TOOL_ID, 0)
        for event in (
            mon.events.PY_START,
            mon.events.LINE,
            mon.events.PY_RETURN,
            mon.events.PY_UNWIND,
            mon.events.PY_YIELD,
            mon.events.PY_RESUME,
            mon.events.RAISE,
        ):
            mon.register_callback(self.TOOL_ID, event, None)
        mon.free_tool_id(self.TOOL_ID)
        self._installed = False
        self._tracer = None

    # -- callbacks ---------------------------------------------------------

    def _frame(self) -> FrameType | None:
        """The frame the current callback is reporting on.

        Monitoring passes a code object rather than a frame, and locals can only be read from a
        frame. Depth 1 is the monitored frame; depth 0 is the callback itself.
        """
        try:
            return sys._getframe(2)  # noqa: SLF001 - the only way to reach the monitored frame
        except ValueError:  # pragma: no cover - defensive
            return None

    def _on_start(self, code: Any, _offset: int) -> Any:
        tracer = self._tracer
        frame = self._frame()
        if tracer is None or frame is None or tracer.ignores(frame):
            return sys.monitoring.DISABLE
        if not tracer.in_scope(frame):
            # Monitoring is process-wide. Anything not descended from the program being traced is
            # somebody else's business, and saying DISABLE means never being asked about it again.
            return sys.monitoring.DISABLE
        tracer.handle_call(frame)
        # Never DISABLE here, even for library code.
        #
        # DISABLE is permanent for a code location, so disabling PY_START for `json.dumps` after the
        # first call meant the next seventy-nine were never reported at all — 480 missing steps, and a
        # trace claiming one library call where the program made eighty. It looked like a 5x speedup
        # and was actually silently dropped work. Line events inside the frame are still disabled,
        # which is both safe and where the real saving is.
        return None

    def _on_line(self, code: Any, line: int) -> Any:
        tracer = self._tracer
        frame = self._frame()
        if tracer is None or frame is None or tracer.ignores(frame):
            return sys.monitoring.DISABLE
        if not tracer.wants_lines(frame):
            # Either a frame the tracer declined at entry, or library code whose interior is
            # deliberately opaque. Never of interest, so DISABLE rather than being asked again — which
            # is precisely where monitoring beats settrace, since settrace re-checks every line.
            return sys.monitoring.DISABLE
        tracer.handle_line(frame)
        return None

    def _on_return(self, code: Any, _offset: int, value: Any) -> Any:
        tracer = self._tracer
        frame = self._frame()
        if tracer is None or frame is None or tracer.ignores(frame):
            return None
        tracer.handle_return(frame, value)
        return None

    def _on_unwind(self, code: Any, _offset: int, _exception: BaseException) -> Any:
        # A frame leaving because an exception passed through it. settrace reports this as a return
        # with no value, and it is reported the same way here so the two streams match.
        tracer = self._tracer
        frame = self._frame()
        if tracer is None or frame is None or tracer.ignores(frame):
            return None
        tracer.handle_return(frame, None)
        return None

    def _on_resume(self, code: Any, _offset: int) -> Any:
        # A suspended generator picking up where it left off. settrace calls this a new call, so it is
        # reported as one here too.
        tracer = self._tracer
        frame = self._frame()
        if tracer is None or frame is None or tracer.ignores(frame):
            return None
        if not tracer.in_scope(frame):
            return sys.monitoring.DISABLE
        tracer.handle_call(frame)
        return None

    def _on_raise(self, code: Any, _offset: int, exception: BaseException) -> Any:
        tracer = self._tracer
        frame = self._frame()
        if tracer is None or frame is None or tracer.ignores(frame):
            return None
        tracer.handle_raise(frame, type(exception), exception)
        return None


def choose_backend(prefer: str = "auto") -> Backend:
    """Pick a backend.

    ``auto`` takes monitoring where it exists and settrace otherwise. The other values force one, so
    the conformance suite can run the same program through both and compare.
    """
    if prefer == "settrace":
        return SettraceBackend()
    if prefer == "monitoring":
        return MonitoringBackend()
    if prefer != "auto":
        raise ValueError(f"unknown backend {prefer!r}; expected auto, settrace or monitoring")

    # settrace, even on versions where monitoring exists.
    #
    # The plan assumed monitoring would be a straight win on 3.12+. Measurement said otherwise: it is
    # only 1.07-1.16x faster, and it reports a single-line loop — a comprehension, or
    # `for i in range(3): t += i` — as *one* step, because LINE fires on a line transition rather than
    # on every re-entry to the line. settrace shows each iteration.
    #
    # Hiding loop iterations to save a tenth of the time is a bad trade for a tool whose entire
    # purpose is showing loop iterations. Choosing per Python version would also mean the same program
    # traced differently on 3.11 and 3.12, which is the kind of inconsistency nobody can diagnose.
    #
    # Monitoring stays available explicitly, for anyone who wants the speed and accepts the coarser
    # trace. See docs/decisions/0002-tracing-backend.md.
    return SettraceBackend()
