"""Trace validation for adapters, with no third-party dependencies.

The TypeScript side validates with Ajv against the generated JSON Schema. Python cannot take that
route: the tracer must stay dependency-free so the identical code runs inside Pyodide, and a
validator that requires ``pip install jsonschema`` is a validator that gets skipped precisely when
an adapter is being developed and needs it most.

So this checks against the field tables embedded in ``events.py`` at generation time. Same model,
same contract, no imports outside the standard library.

Two layers, matching the TypeScript side:

* :func:`validate_event` and :func:`validate_trace` check shape - required fields, types, enum
  membership, well-formed values.
* :func:`check_trace_invariants` checks coherence - monotonic sequence numbers, balanced frames, no
  mutation of objects that were never allocated. A trace can be perfectly shaped and still
  nonsensical, and these are the errors that produce a confusing visualization rather than a crash.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

from .events import ENUM_VALUES, EVENT_SPEC, STRUCT_SPEC, VALUE_VARIANTS

__all__ = [
    "Failure",
    "ValidationResult",
    "validate_event",
    "validate_events",
    "validate_trace",
    "check_trace_invariants",
    "assert_valid_trace",
]


@dataclass(frozen=True)
class Failure:
    """One problem found, with the path that led to it."""

    path: str
    message: str

    def __str__(self) -> str:  # pragma: no cover - presentation only
        return f"{self.path}: {self.message}"


@dataclass
class ValidationResult:
    """Outcome of a validation pass."""

    errors: list[Failure] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return not self.errors

    def add(self, path: str, message: str) -> None:
        self.errors.append(Failure(path, message))

    def extend(self, other: ValidationResult, prefix: str = "") -> None:
        for error in other.errors:
            self.errors.append(Failure(f"{prefix}{error.path}", error.message))

    def describe(self, limit: int = 8) -> str:
        if self.valid:
            return "valid"
        shown = "\n".join(f"  {error}" for error in self.errors[:limit])
        more = f"\n  ...and {len(self.errors) - limit} more" if len(self.errors) > limit else ""
        return f"{len(self.errors)} problem(s):\n{shown}{more}"


# ---------------------------------------------------------------------------
# type checking
# ---------------------------------------------------------------------------

_DISCRIMINATORS = {keys[0] for keys in VALUE_VARIANTS.values()}


def _check_scalar(spec: str, value: Any, path: str, result: ValidationResult) -> None:
    if spec == "int":
        # bool is a subclass of int in Python, and letting True pass as an object id would produce
        # a trace that validates and then makes no sense.
        if not isinstance(value, int) or isinstance(value, bool):
            result.add(path, f"expected an integer, found {type(value).__name__}")
    elif spec == "float":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            result.add(path, f"expected a number, found {type(value).__name__}")
    elif spec == "bool":
        if not isinstance(value, bool):
            result.add(path, f"expected a boolean, found {type(value).__name__}")
    elif spec == "string":
        if not isinstance(value, str):
            result.add(path, f"expected a string, found {type(value).__name__}")
    elif spec == "primitive":
        if value is not None and not isinstance(value, (bool, int, float, str)):
            result.add(path, f"expected a primitive, found {type(value).__name__}")


def _check_value(value: Any, path: str, result: ValidationResult) -> None:
    """A Value must carry exactly one variant discriminator."""
    if not isinstance(value, Mapping):
        result.add(path, f"expected a value object, found {type(value).__name__}")
        return
    present = [key for key in value if key in _DISCRIMINATORS]
    if not present:
        result.add(path, f"no value variant present; expected one of {sorted(_DISCRIMINATORS)}")
        return
    if len(present) > 1:
        result.add(path, f"value has more than one variant: {sorted(present)}")
        return

    variant = present[0]
    allowed = next((keys for name, keys in VALUE_VARIANTS.items() if keys[0] == variant), ())
    for key in value:
        if key not in allowed:
            result.add(path, f"unexpected member {key!r} on a {variant!r} value")


def _check_type(spec: str, value: Any, path: str, result: ValidationResult) -> None:
    if spec in {"int", "float", "bool", "string", "primitive"}:
        _check_scalar(spec, value, path, result)
        return
    if spec == "any":
        return
    if spec == "Value":
        _check_value(value, path, result)
        return
    if spec.startswith("enum:"):
        name = spec[5:]
        permitted = ENUM_VALUES.get(name, ())
        if value not in permitted:
            result.add(path, f"{value!r} is not a valid {name}; expected one of {list(permitted)}")
        return
    if spec.startswith("array:"):
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
            result.add(path, f"expected a list, found {type(value).__name__}")
            return
        for index, item in enumerate(value):
            _check_type(spec[6:], item, f"{path}[{index}]", result)
        return
    if spec.startswith("map:"):
        if not isinstance(value, Mapping):
            result.add(path, f"expected an object, found {type(value).__name__}")
            return
        for key, item in value.items():
            _check_type(spec[4:], item, f"{path}.{key}", result)
        return

    fields = STRUCT_SPEC.get(spec)
    if fields is None:
        # An unknown type name means the model and this file disagree, which is a build problem
        # rather than a problem with the trace being checked.
        result.add(path, f"schema refers to unknown type {spec!r}; regenerate the schema artifacts")
        return
    _check_object(fields, value, path, result)


def _check_object(
    fields: Mapping[str, Mapping[str, object]],
    value: Any,
    path: str,
    result: ValidationResult,
) -> None:
    if not isinstance(value, Mapping):
        result.add(path, f"expected an object, found {type(value).__name__}")
        return
    for name, spec in fields.items():
        if name not in value:
            if spec.get("required"):
                result.add(path, f"missing required field {name!r}")
            continue
        _check_type(str(spec["type"]), value[name], f"{path}.{name}" if path else name, result)


# ---------------------------------------------------------------------------
# events
# ---------------------------------------------------------------------------


def validate_event(event: Any, path: str = "") -> ValidationResult:
    """Check one event.

    An unrecognised event type is accepted, not rejected. Within a major schema version new event
    types may be added, and a consumer that refuses them would break on every forward-compatible
    release.
    """
    result = ValidationResult()
    if not isinstance(event, Mapping):
        result.add(path or "/", f"expected an event object, found {type(event).__name__}")
        return result

    kind = event.get("t")
    if not isinstance(kind, str):
        result.add(f"{path}.t" if path else "t", "event has no type")
        return result

    spec = EVENT_SPEC.get(kind)
    if spec is None:
        return result

    _check_object(spec, event, path, result)
    return result


def validate_events(events: Iterable[Any]) -> ValidationResult:
    """Check every event, reporting each failure with its index."""
    result = ValidationResult()
    for index, event in enumerate(events):
        result.extend(validate_event(event, f"events[{index}]"))
    return result


def validate_trace(trace: Any) -> ValidationResult:
    """Check a whole trace document: header, then every event."""
    result = ValidationResult()
    if not isinstance(trace, Mapping):
        result.add("/", f"expected a trace object, found {type(trace).__name__}")
        return result

    for key in ("schema", "session", "events"):
        if key not in trace:
            result.add("/", f"missing required field {key!r}")

    session = trace.get("session")
    if session is not None:
        _check_object(STRUCT_SPEC["Session"], session, "session", result)

    events = trace.get("events")
    if events is None:
        return result
    if not isinstance(events, Sequence):
        result.add("events", f"expected a list, found {type(events).__name__}")
        return result

    result.extend(validate_events(events))
    return result


# ---------------------------------------------------------------------------
# coherence
# ---------------------------------------------------------------------------


def check_trace_invariants(trace: Mapping[str, Any]) -> ValidationResult:
    """Check the structural rules the field tables cannot express.

    These are the assertions every adapter must satisfy, and the reason a new language cannot
    quietly invent its own dialect of the format.
    """
    result = ValidationResult()
    events = trace.get("events") or []

    last_seq = -1
    last_step = -1
    open_frames: list[int] = []
    live_objects: set[int] = set()
    ended = False

    for index, event in enumerate(events):
        if not isinstance(event, Mapping):
            continue
        path = f"events[{index}]"

        seq = event.get("seq")
        if isinstance(seq, int):
            if seq <= last_seq:
                result.add(path, f"seq {seq} is not greater than {last_seq}")
            last_seq = seq

        step = event.get("step")
        if isinstance(step, int):
            if step < last_step:
                result.add(path, f"step {step} went backwards from {last_step}")
            last_step = step

        if ended:
            result.add(path, "event follows run_end")

        kind = event.get("t")
        if kind == "run_start" and index != 0:
            result.add(path, "run_start is not the first event")
        elif kind == "run_end":
            ended = True
        elif kind == "frame_push":
            frame = event.get("frame")
            if isinstance(frame, int):
                open_frames.append(frame)
        elif kind == "frame_pop":
            frame = event.get("frame")
            if not open_frames:
                result.add(path, "frame_pop with no open frame")
            else:
                innermost = open_frames.pop()
                if isinstance(frame, int) and innermost != frame:
                    result.add(
                        path,
                        f"frame_pop closed frame {frame} but {innermost} was innermost",
                    )
        elif kind == "obj_new":
            obj = event.get("obj")
            if isinstance(obj, int):
                if obj in live_objects:
                    result.add(path, f"object {obj} allocated twice")
                live_objects.add(obj)
        elif kind in {"obj_set", "obj_resize"}:
            obj = event.get("obj")
            if isinstance(obj, int) and obj not in live_objects:
                result.add(path, f"mutation of unknown object {obj}")
        elif kind == "obj_free":
            obj = event.get("obj")
            if isinstance(obj, int):
                if obj not in live_objects:
                    result.add(path, f"free of unknown object {obj}")
                else:
                    live_objects.discard(obj)

    if events:
        first = events[0]
        if not isinstance(first, Mapping) or first.get("t") != "run_start":
            result.add("events[0]", "trace does not begin with run_start")
        if not ended:
            result.add("events", "trace has no run_end")
    if open_frames:
        joined = ", ".join(str(frame) for frame in open_frames)
        result.add("events", f"{len(open_frames)} frame(s) never popped: {joined}")

    return result


def assert_valid_trace(trace: Mapping[str, Any]) -> None:
    """Raise if a trace is invalid or incoherent. Intended for adapter tests."""
    shape = validate_trace(trace)
    if not shape.valid:
        raise AssertionError(f"trace failed validation:\n{shape.describe()}")
    coherence = check_trace_invariants(trace)
    if not coherence.valid:
        raise AssertionError(f"trace violated invariants:\n{coherence.describe()}")
