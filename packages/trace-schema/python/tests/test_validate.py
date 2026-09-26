"""Tests for the dependency-free Python validator.

These mirror the TypeScript validator's behaviour on purpose. Two validators that disagree about
what a valid trace is would be worse than having only one, so the same cases are asserted on both
sides: required fields, enum membership, exactly-one-variant values, tolerance of unknown event
types and unknown fields, and the structural invariants.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_view_schema import (
    SCHEMA_ID,
    assert_valid_trace,
    check_trace_invariants,
    validate_event,
    validate_trace,
)

SESSION = {
    "id": "test",
    "language": "python",
    "language_version": "3.12.0",
    "adapter_version": "0.1.0",
    "profile": "full",
    "source_files": [{"path": "main.py", "sha256": "0" * 64, "line_count": 1}],
    "entry": {"path": "main.py", "line": 1},
    "limits": {"max_steps": 1000, "wall_ms": 1000, "memory_mb": 64, "output_bytes": 1024},
    "started_at": "2026-01-01T00:00:00Z",
}


def trace(*events: dict) -> dict:
    return {"schema": SCHEMA_ID, "session": SESSION, "events": list(events)}


class TestEventShape:
    def test_accepts_a_well_formed_event(self) -> None:
        result = validate_event(
            {"seq": 1, "t": "var_set", "name": "x", "value": {"prim": 3}, "scope": "local"}
        )
        assert result.valid, result.describe()

    def test_reports_every_missing_required_field(self) -> None:
        result = validate_event({"seq": 1, "t": "var_set", "name": "x"})
        assert not result.valid
        messages = " ".join(error.message for error in result.errors)
        assert "value" in messages
        assert "scope" in messages

    def test_rejects_a_value_outside_an_enum(self) -> None:
        result = validate_event(
            {"seq": 1, "t": "var_set", "name": "x", "value": {"prim": 1}, "scope": "nonsense"}
        )
        assert not result.valid
        assert "not a valid VarScope" in result.errors[0].message

    def test_rejects_a_bool_where_an_integer_belongs(self) -> None:
        # bool subclasses int in Python, so this needs an explicit guard rather than isinstance.
        result = validate_event({"seq": True, "t": "run_start"})
        assert not result.valid
        assert "integer" in result.errors[0].message

    def test_tolerates_an_unknown_event_type(self) -> None:
        # Forward compatibility within a major version.
        assert validate_event({"seq": 1, "t": "something_from_a_later_release"}).valid

    def test_tolerates_an_unknown_field(self) -> None:
        result = validate_event(
            {
                "seq": 1,
                "t": "var_set",
                "name": "x",
                "value": {"prim": 1},
                "scope": "local",
                "field_added_later": True,
            }
        )
        assert result.valid, result.describe()

    def test_requires_an_event_type(self) -> None:
        result = validate_event({"seq": 1})
        assert not result.valid
        assert "no type" in result.errors[0].message


class TestValues:
    def test_rejects_a_value_with_two_variants(self) -> None:
        result = validate_event(
            {"seq": 1, "t": "var_set", "name": "x", "value": {"prim": 1, "ref": 2}, "scope": "local"}
        )
        assert not result.valid
        assert "more than one variant" in result.errors[0].message

    def test_rejects_a_value_with_no_variant(self) -> None:
        result = validate_event(
            {"seq": 1, "t": "var_set", "name": "x", "value": {"nope": 1}, "scope": "local"}
        )
        assert not result.valid
        assert "no value variant" in result.errors[0].message

    @pytest.mark.parametrize(
        "value",
        [
            {"prim": None},
            {"prim": True},
            {"prim": 42},
            {"prim": 3.5},
            {"prim": "text"},
            {"prim": "9" * 40, "bigint": True},
            {"prim": "abc", "truncated": 4096},
            {"ref": 7},
            {"addr": "0x1f", "type": "int*"},
            {"addr": "0x1f", "type": "int*", "dangling": True},
            {"unavailable": "optimized out"},
        ],
    )
    def test_accepts_every_variant(self, value: dict) -> None:
        result = validate_event(
            {"seq": 1, "t": "var_set", "name": "x", "value": value, "scope": "local"}
        )
        assert result.valid, result.describe()

    def test_rejects_a_member_from_the_wrong_variant(self) -> None:
        result = validate_event(
            {"seq": 1, "t": "var_set", "name": "x", "value": {"ref": 1, "type": "int*"}, "scope": "local"}
        )
        assert not result.valid


class TestNestedTypes:
    def test_validates_inside_a_list_of_structs(self) -> None:
        result = validate_event(
            {
                "seq": 1,
                "t": "frame_push",
                "frame": 0,
                "func": "f",
                "args": [{"name": "a", "value": {"prim": 1}}, {"name": "b"}],
                "kind": "user",
                "recursion_depth": 0,
            }
        )
        assert not result.valid
        assert "args[1]" in result.errors[0].path

    def test_validates_the_session_header(self) -> None:
        broken = dict(SESSION)
        broken["language"] = "cobol"
        result = validate_trace({"schema": SCHEMA_ID, "session": broken, "events": []})
        assert not result.valid
        assert "not a valid Language" in result.errors[0].message


class TestInvariants:
    def test_accepts_a_coherent_trace(self) -> None:
        document = trace(
            {"seq": 0, "t": "run_start"},
            {"seq": 1, "t": "frame_push", "frame": 0, "func": "m", "args": [], "kind": "user", "recursion_depth": 0, "step": 0},
            {"seq": 2, "t": "frame_pop", "frame": 0, "reason": "implicit", "step": 1},
            {"seq": 3, "t": "run_end", "status": "ok", "steps": 2, "duration_ms": 1.0},
        )
        assert_valid_trace(document)

    def test_rejects_a_repeated_sequence_number(self) -> None:
        result = check_trace_invariants(
            trace({"seq": 0, "t": "run_start"}, {"seq": 0, "t": "run_end", "status": "ok", "steps": 0, "duration_ms": 0.0})
        )
        assert not result.valid
        assert "not greater than" in result.errors[0].message

    def test_rejects_an_unbalanced_frame(self) -> None:
        result = check_trace_invariants(
            trace(
                {"seq": 0, "t": "run_start"},
                {"seq": 1, "t": "frame_push", "frame": 0, "func": "m", "args": [], "kind": "user", "recursion_depth": 0},
                {"seq": 2, "t": "run_end", "status": "ok", "steps": 1, "duration_ms": 0.0},
            )
        )
        assert not result.valid
        assert "never popped" in result.errors[-1].message

    def test_rejects_popping_a_frame_that_is_not_innermost(self) -> None:
        result = check_trace_invariants(
            trace(
                {"seq": 0, "t": "run_start"},
                {"seq": 1, "t": "frame_push", "frame": 0, "func": "a", "args": [], "kind": "user", "recursion_depth": 0},
                {"seq": 2, "t": "frame_push", "frame": 1, "func": "b", "args": [], "kind": "user", "recursion_depth": 0},
                {"seq": 3, "t": "frame_pop", "frame": 0, "reason": "return"},
                {"seq": 4, "t": "frame_pop", "frame": 1, "reason": "return"},
                {"seq": 5, "t": "run_end", "status": "ok", "steps": 4, "duration_ms": 0.0},
            )
        )
        assert not result.valid
        assert "was innermost" in result.errors[0].message

    def test_rejects_mutating_an_object_never_allocated(self) -> None:
        result = check_trace_invariants(
            trace(
                {"seq": 0, "t": "run_start"},
                {"seq": 1, "t": "obj_set", "obj": 99, "key": 0, "value": {"prim": 1}, "op": "set"},
                {"seq": 2, "t": "run_end", "status": "ok", "steps": 0, "duration_ms": 0.0},
            )
        )
        assert not result.valid
        assert "unknown object 99" in result.errors[0].message

    def test_rejects_an_event_after_the_run_ended(self) -> None:
        result = check_trace_invariants(
            trace(
                {"seq": 0, "t": "run_start"},
                {"seq": 1, "t": "run_end", "status": "ok", "steps": 0, "duration_ms": 0.0},
                {"seq": 2, "t": "step_line", "line": 1},
            )
        )
        assert not result.valid
        assert "follows run_end" in result.errors[0].message

    def test_accepts_a_truncated_run_as_valid(self) -> None:
        # A run stopped by its step budget is a usable result, not a malformed trace.
        document = trace(
            {"seq": 0, "t": "run_start"},
            {"seq": 1, "t": "note", "level": "warn", "text": "step budget reached"},
            {"seq": 2, "t": "run_end", "status": "step_limit", "steps": 1, "duration_ms": 5.0},
        )
        assert_valid_trace(document)


class TestGeneratedArtifacts:
    def test_json_schema_and_field_tables_describe_the_same_events(self) -> None:
        # Both artifacts come from one model; if they ever disagree, the generator is broken and
        # the two validators would accept different traces.
        from flow_view_schema.events import EVENT_SPEC

        schema_path = Path(__file__).resolve().parents[2] / "generated" / "trace.schema.json"
        schema = json.loads(schema_path.read_text())
        from_schema = {
            name[len("Event_") :] for name in schema["$defs"] if name.startswith("Event_")
        }
        assert from_schema == set(EVENT_SPEC)
