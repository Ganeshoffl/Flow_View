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
    )

    def __init__(
        self,
        stream: TextIO | None = None,
        *,
        limits: Limits | None = None,
        on_event: Callable[[dict[str, Any]], None] | None = None,
        clock: Callable[[], float] | None = None,
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

    # -- timing ------------------------------------------------------------

    def elapsed_ms(self) -> float:
        return (self._clock() - self._started) * 1000.0

    @property
    def stopped(self) -> bool:
        return self._stopped

    @property
    def stop_reason(self) -> str | None:
        return self._stop_reason

    # -- emission ----------------------------------------------------------

    def emit(self, kind: str, payload: dict[str, Any] | None = None) -> None:
        """Write one event, assigning ``seq``, ``ms`` and — where applicable — ``step``."""
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
