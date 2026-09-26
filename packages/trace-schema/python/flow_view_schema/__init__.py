"""The Universal Trace contract, for Python adapters.

``events`` holds types and constants generated from ``model/trace.model.json``; ``validate`` checks
traces against the same contract without any third-party dependency, because the tracer must run
unchanged inside Pyodide.
"""

from .events import (
    EVENT_TYPES,
    SCHEMA_ID,
    SCHEMA_VERSION_MAJOR,
    STEPPABLE_EVENT_TYPES,
)
from .validate import (
    Failure,
    ValidationResult,
    assert_valid_trace,
    check_trace_invariants,
    validate_event,
    validate_events,
    validate_trace,
)

__all__ = [
    "EVENT_TYPES",
    "SCHEMA_ID",
    "SCHEMA_VERSION_MAJOR",
    "STEPPABLE_EVENT_TYPES",
    "Failure",
    "ValidationResult",
    "assert_valid_trace",
    "check_trace_invariants",
    "validate_event",
    "validate_events",
    "validate_trace",
]
