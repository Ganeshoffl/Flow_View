"""Writing trace events.

Owns four things the tracer should not have to think about: sequence and step numbering, encoding
Python values into schema values, the resource budgets, and the transport.

Events are written as JSON Lines to a stream chosen by the caller — a pipe to the server in the Full
profile, a callback in the Lite profile. One event per line means the reader can begin rendering the
first step while the program is still running, which is what makes a long run show progress instead
of appearing to hang.

The budgets live here rather than in the runner because a runaway program has to be stopped from
*inside*. An infinite loop that allocates nothing would never trip a memory limit and never yield to
a supervisor; the only reliable place to notice is the step counter that this class already keeps.
"""

from __future__ import annotations

import json
import math
from typing import Any, Callable, TextIO

__all__ = ["BudgetExceeded", "Emitter", "Limits", "encode_value"]

#: Strings longer than this are truncated, with the original length recorded. A single multi-megabyte
#: string would otherwise dominate a trace and tell the reader nothing they could not learn from the
#: first kilobyte.
MAX_STRING = 1024

#: Integers outside the range a double can hold exactly travel as strings, flagged as bigint, because
#: JSON numbers are doubles and 2**70 would silently arrive as a different number.
_SAFE_INT = 2**53 - 1

#: Event types a user can land on when stepping. Mirrors STEPPABLE_EVENT_TYPES in the schema package;
#: duplicated as a literal here so the tracer keeps zero dependencies and runs inside Pyodide.
STEPPABLE = frozenset(
    {
        "step_line",
        "branch",
        "jump",
        "frame_push",
        "frame_pop",
        "exception_raise",
        "exception_catch",
        "collapse",
    }
)


class BudgetExceeded(Exception):
    """Raised inside the traced program to stop it when a budget runs out.

    Raising into the program is the only way to halt it from a trace callback. The tracer recognises
    this exception and keeps it out of the trace, so a stopped run reports ``step_limit`` rather than
    appearing to have crashed with an error the user's code never raised.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class Limits:
    """Resource ceilings for one run."""

    __slots__ = ("max_steps", "wall_ms", "memory_mb", "output_bytes")

    def __init__(
        self,
        max_steps: int = 200_000,
        wall_ms: int = 30_000,
        memory_mb: int = 512,
        output_bytes: int = 1_048_576,
    ) -> None:
        self.max_steps = max_steps
        self.wall_ms = wall_ms
        self.memory_mb = memory_mb
        self.output_bytes = output_bytes

    def as_dict(self) -> dict[str, int]:
        return {
            "max_steps": self.max_steps,
            "wall_ms": self.wall_ms,
            "memory_mb": self.memory_mb,
            "output_bytes": self.output_bytes,
        }


# ---------------------------------------------------------------------------
# values
# ---------------------------------------------------------------------------


def encode_value(value: tuple[str, Any]) -> dict[str, Any]:
    """Turn a walker value into a schema ``Value``.

    The walker speaks in tuples because they are cheap to compare when diffing; the trace speaks in
    objects because that is the contract. This is where the two meet.
    """
    kind, payload = value
    if kind == "ref":
        return {"ref": payload}
    return encode_primitive(payload)


def encode_primitive(payload: Any) -> dict[str, Any]:
    """Encode a Python primitive, preserving what JSON would otherwise destroy."""
    if payload is None or isinstance(payload, bool):
        return {"prim": payload}

    if isinstance(payload, int):
        # Beyond a double's exact range, a JSON number would arrive as a different integer.
        if payload > _SAFE_INT or payload < -_SAFE_INT:
            return {"prim": str(payload), "bigint": True}
        return {"prim": payload}

    if isinstance(payload, float):
        if math.isnan(payload):
            return {"prim": "nan"}
        if math.isinf(payload):
            return {"prim": "inf" if payload > 0 else "-inf"}
        return {"prim": payload}

    if isinstance(payload, str):
        if len(payload) > MAX_STRING:
            return {"prim": payload[:MAX_STRING], "truncated": len(payload)}
        return {"prim": payload}

    if isinstance(payload, bytes):
        text = repr(payload)
        if len(text) > MAX_STRING:
            return {"prim": text[:MAX_STRING], "truncated": len(text)}
        return {"prim": text}

    if isinstance(payload, complex):
        return {"prim": str(payload)}

    # Anything else is a value the walker chose to summarise rather than follow.
    return {"prim": str(payload)}


# ---------------------------------------------------------------------------
# emitter
# ---------------------------------------------------------------------------


class Emitter:
    """Assigns sequence numbers, enforces budgets, writes events."""

    __slots__ = (
        "_write",
        "_flush",
        "seq",
        "step",
        "limits",
        "_clock",
        "_started",
        "_output_bytes",
        "_output_capped",
        "_stopped",
        "_stop_reason",
        "_notes_sent",
        "_last_flush",
        "_idle_ms",
        "_collapser",
    )

    #: How long a finished event may sit in the buffer before it is pushed out, in milliseconds.
    #:
    #: Matched to the server's batching window: flushing more often buys nothing the viewer can see,
    #: and flushing less often is what "live" stops meaning.
    FLUSH_INTERVAL_MS = 16.0

    #: Events after which the buffer is emptied immediately, whatever the interval says.
    #:
    #: `stdin_request` is the one that matters. Python block-buffers a pipe, so a program that stopped
    #: to ask a question left its question in an 8 KB buffer that nothing would empty until the
    #: program ended — and it could not end, because it was waiting for the answer to the question
    #: nobody had been shown. The UI sat on "running" while the run was deadlocked.
    URGENT = frozenset({"stdin_request", "run_end", "note", "error"})

    def __init__(
        self,
        stream: TextIO | None = None,
        *,
        limits: Limits | None = None,
        on_event: Callable[[dict[str, Any]], None] | None = None,
        clock: Callable[[], float] | None = None,
        collapser: Any = None,
    ) -> None:
        if stream is None and on_event is None:
            raise ValueError("an emitter needs either a stream or an on_event callback")

        if on_event is not None:
            self._write = on_event
            self._flush = lambda: None
        else:
            assert stream is not None

            def write(event: dict[str, Any]) -> None:
                stream.write(json.dumps(event, separators=(",", ":")))
                stream.write("\n")

            self._write = write
            self._flush = stream.flush

        import time

        self._clock = clock or time.perf_counter
        self._started = self._clock()
        self.seq = 0
        self.step = 0
        self.limits = limits or Limits()
        self._output_bytes = 0
        self._output_capped = False
        self._stopped = False
        self._stop_reason: str | None = None
        self._notes_sent: set[str] = set()
        self._last_flush = self._started
        self._idle_ms = 0.0
        self._collapser = collapser
        if collapser is not None and getattr(collapser, "_seq", None) is not None:
            # The collapser stamps from_seq/to_seq onto the spans it folds, and only this knows the
            # numbering.
            collapser._seq = lambda: self.seq

    # -- timing ------------------------------------------------------------

    def elapsed_ms(self) -> float:
        """How long the *program* has been running.

        Time spent blocked waiting for a person to type an answer is not the program's time, and
        charging it to the program was wrong twice over: the wall-clock budget killed runs for
        "timeout" when the only thing that had taken 30 seconds was somebody reading the question, and
        the elapsed clock in the UI reported thinking time as execution time.
        """
        return (self._clock() - self._started) * 1000.0 - self._idle_ms

    def discount_idle(self, ms: float) -> None:
        """Exclude a stretch of waiting on a human from the program's elapsed time."""
        if ms > 0:
            self._idle_ms += ms

    @property
    def stopped(self) -> bool:
        return self._stopped

    @property
    def stop_reason(self) -> str | None:
        return self._stop_reason

    # -- emission ----------------------------------------------------------

    def emit(self, kind: str, payload: dict[str, Any] | None = None) -> None:
        """Write one event, assigning ``seq``, ``ms`` and — where applicable — ``step``.

        With a collapser attached, events pass through it first. It happens *before* numbering on
        purpose: a folded event never receives a ``seq`` or a ``step``, so both stay dense and a
        collapsed trace is numbered as though the folded iterations had never been separate steps —
        which is the point of folding them.
        """
        if self._stopped:
            return
        if self._collapser is not None:
            for out_kind, out_payload in self._collapser.feed(kind, payload):
                self._emit_now(out_kind, out_payload)
            return
        self._emit_now(kind, payload)

    def drain_collapser(self) -> None:
        """Emit anything the collapser is still holding. Called once, as the run ends."""
        if self._collapser is None:
            return
        collapser, self._collapser = self._collapser, None
        for kind, payload in collapser.drain():
            self._emit_now(kind, payload)

    def _emit_now(self, kind: str, payload: dict[str, Any] | None = None) -> None:
        if self._stopped:
            return
        event: dict[str, Any] = {"seq": self.seq, "t": kind}
        self.seq += 1
        if payload:
            event.update(payload)
        event["ms"] = round(self.elapsed_ms(), 3)
        if kind in STEPPABLE:
            event["step"] = self.step
            self.step += 1
        self._write(event)

        # Get it out of the buffer. See URGENT and FLUSH_INTERVAL_MS above: without this the trace
        # only reached the viewer 8 KB at a time, so nothing was live and a blocking read deadlocked.
        if kind in self.URGENT:
            self._flush()
            self._last_flush = self._clock()
        else:
            now = self._clock()
            if (now - self._last_flush) * 1000.0 >= self.FLUSH_INTERVAL_MS:
                self._flush()
                self._last_flush = now

    def note(self, level: str, text: str, *, once: bool = True) -> None:
        """Surface a diagnostic to the user.

        Deduplicated by default. A ceiling that bites on every step of a loop would otherwise bury
        the trace in identical warnings and tell the reader nothing after the first.
        """
        if once:
            if text in self._notes_sent:
                return
            self._notes_sent.add(text)
        self.emit("note", {"level": level, "text": text})

    def output(self, stream_name: str, text: str, frame: int | None, line: int | None) -> None:
        """Record program output, truncating once the cap is reached."""
        if self._stopped:
            return
        remaining = self.limits.output_bytes - self._output_bytes
        if remaining <= 0:
            if not self._output_capped:
                self._output_capped = True
                self.note(
                    "warn",
                    f"Output passed {self.limits.output_bytes} bytes. "
                    "Further output is not recorded.",
                )
            return
        encoded = text.encode("utf-8", "replace")
        if len(encoded) > remaining:
            text = encoded[:remaining].decode("utf-8", "ignore")
        self._output_bytes += len(encoded)
        payload: dict[str, Any] = {"text": text}
        if frame is not None:
            payload["frame"] = frame
        if line is not None:
            payload["line"] = line
        self.emit(stream_name, payload)

    # -- budgets -----------------------------------------------------------

    def check_budget(self) -> None:
        """Stop the run if a ceiling has been reached.

        Called once per step. Raises :class:`BudgetExceeded` into the traced program, which is the
        only way to halt it from inside a trace callback.
        """
        if self._stopped:
            return
        if self.step >= self.limits.max_steps:
            self._begin_stop("step_limit")
            self.note(
                "warn",
                f"Stopped after {self.limits.max_steps} steps. "
                "Everything up to this point is shown.",
                once=False,
            )
            raise BudgetExceeded("step_limit")
        if self.elapsed_ms() >= self.limits.wall_ms:
            self._begin_stop("timeout")
            self.note(
                "warn",
                f"Stopped after {self.limits.wall_ms}ms. "
                "Everything up to this point is shown.",
                once=False,
            )
            raise BudgetExceeded("timeout")

    def _begin_stop(self, reason: str) -> None:
        # The stop reason is recorded before the flag is set, so the final note and run_end can
        # still be written while further program events cannot.
        self._stop_reason = reason

    def seal(self) -> None:
        """Refuse further events. Called once the closing ``run_end`` is written."""
        self._stopped = True
        self._flush()

    def flush(self) -> None:
        self._flush()
