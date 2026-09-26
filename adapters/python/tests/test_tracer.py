"""Tests for the Python tracer.

Two layers. Every program in the corpus must produce a trace that is schema-valid and structurally
coherent — that is the gate a new adapter has to pass. Then the semantic tests assert the trace says
the *right* things, because a well-formed trace can still describe a program that never ran that way.

The cases here were chosen from bugs this suite actually caught while the tracer was being written:
the tracer tracing itself, ids handed out without the object being announced, a program's last line
leaving no trace, an unwinding flag that never reset and so misreported every later return.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "packages/trace-schema/python"))

from flow_view_schema import check_trace_invariants, validate_trace  # noqa: E402
from flow_view_tracer.emit import Limits  # noqa: E402
from flow_view_tracer.tracer import TracerOptions, run_source  # noqa: E402


class Traced:
    """A completed trace, with helpers for asking questions about it."""

    def __init__(self, source: str, limits: Limits | None = None, **kwargs: Any) -> None:
        self.events: list[dict[str, Any]] = []
        self.header: dict[str, Any] = {}

        def sink(event: dict[str, Any]) -> None:
            if "session" in event:
                self.header.update(event)
            else:
                self.events.append(event)

        self.status = run_source(source, "main.py", on_event=sink, limits=limits, **kwargs)

    @property
    def document(self) -> dict[str, Any]:
        return {
            "schema": self.header.get("schema"),
            "session": self.header.get("session"),
            "events": self.events,
        }

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [event for event in self.events if event["t"] == kind]

    def one(self, kind: str) -> dict[str, Any]:
        found = self.of(kind)
        assert len(found) == 1, f"expected exactly one {kind}, found {len(found)}"
        return found[0]

    def sets_of(self, name: str) -> list[dict[str, Any]]:
        return [e for e in self.of("var_set") if e["name"] == name]

    def final(self, name: str) -> Any:
        found = self.sets_of(name)
        assert found, f"{name} was never assigned"
        return found[-1]["value"]

    def assert_well_formed(self) -> None:
        shape = validate_trace(self.document)
        assert shape.valid, shape.describe()
        coherence = check_trace_invariants(self.document)
        assert coherence.valid, coherence.describe()


# ---------------------------------------------------------------------------
# the corpus
# ---------------------------------------------------------------------------

CORPUS: dict[str, str] = {
    "assignment": "x = 1\ny = x + 2\nprint(y)\n",
    "rebinding": "n = 0\nn = n + 5\nn = n * 3\n",
    "branch-if": "s = 95\nif s >= 90:\n    g = 'A'\nelse:\n    g = 'B'\n",
    "branch-elif": "s = 72\nif s >= 90:\n    g='A'\nelif s >= 70:\n    g='B'\nelse:\n    g='C'\n",
    "for-loop": "t = 0\nfor i in range(5):\n    t += i\n",
    "while-loop": "n = 0\nwhile n < 4:\n    n += 1\n",
    "break": "for i in range(9):\n    if i == 3:\n        break\n",
    "continue": "seen = 0\nfor i in range(4):\n    if i == 1:\n        continue\n    seen += 1\n",
    "nested-loops": "p = 0\nfor i in range(3):\n    for j in range(2):\n        p += 1\n",
    "function": "def add(a, b):\n    return a + b\nr = add(3, 4)\n",
    "recursion": "def f(n):\n    if n <= 1:\n        return 1\n    return n * f(n-1)\nr = f(4)\n",
    "closure": "def outer(k):\n    def inner(v):\n        return v + k\n    return inner(1)\nr = outer(10)\n",
    "aliasing": "a = [1, 2]\nb = a\nb.append(3)\n",
    "list-ops": "v = [3, 1, 2]\nv.append(4)\nv.sort()\n",
    "nested-list": "g = [[1, 2], [3, 4]]\ng[0][1] = 9\n",
    "dict": "d = {}\nfor i in range(3):\n    d[str(i)] = i * i\n",
    "set": "s = set()\ns.add(1)\ns.add(2)\n",
    "tuple": "t = (1, [2])\nt[1].append(3)\n",
    "instance": "class P:\n    def __init__(self, v):\n        self.v = v\np = P(7)\n",
    "linked-list": (
        "class N:\n    def __init__(self, v):\n        self.v = v\n        self.next = None\n"
        "h = N(1)\nh.next = N(2)\nh.next.next = N(3)\n"
    ),
    "bst": (
        "class T:\n    def __init__(self, k):\n        self.k = k\n        self.l = None\n"
        "        self.r = None\nroot = T(5)\nroot.l = T(3)\nroot.r = T(8)\n"
    ),
    "comprehension": "sq = [i * i for i in range(4)]\n",
    "generator": "def g():\n    yield 1\n    yield 2\nvals = list(g())\n",
    "caught": "try:\n    1 / 0\nexcept ZeroDivisionError:\n    r = None\n",
    "uncaught": "v = [1, 2]\nprint(v[9])\n",
    "propagating": (
        "def a():\n    raise RuntimeError('x')\ndef b():\n    a()\n"
        "try:\n    b()\nexcept RuntimeError:\n    r = 'caught'\n"
    ),
    "strings": "s = 'ab'\ns = s + 'cd'\n",
    "big-int": "n = 2 ** 80\n",
    "float-edge": "import math\na = math.inf\nb = -math.inf\n",
    "empty-ish": "pass\n",
    "output": "for i in range(3):\n    print(i)\n",
}


@pytest.mark.parametrize("name", sorted(CORPUS))
def test_every_program_produces_a_well_formed_trace(name: str) -> None:
    Traced(CORPUS[name]).assert_well_formed()


@pytest.mark.parametrize("name", sorted(CORPUS))
def test_no_program_leaks_the_tracer_into_its_own_trace(name: str) -> None:
    # The tracer's code is reachable from the traced program: `print` goes through the output proxy.
    # Without a reentrancy guard the trace fills with flow_view's internals, which is a bug this
    # suite found on the very first run.
    traced = Traced(CORPUS[name])
    internal = {"emit", "output", "elapsed_ms", "_current_ids", "_current", "write", "check_budget"}
    leaked = [e["func"] for e in traced.of("frame_push") if e["func"] in internal]
    assert leaked == [], f"tracer internals appeared in the trace: {leaked}"

    paths = {e.get("path") for e in traced.events if e.get("path")}
    assert not any("tracer.py" in path or "emit.py" in path for path in paths)


@pytest.mark.parametrize("name", sorted(CORPUS))
def test_every_reference_points_at_an_announced_object(name: str) -> None:
    # A reference to an object that was never introduced is a trace that mutates something the
    # reader has never seen. The registry announces on first id assignment to make this impossible.
    traced = Traced(CORPUS[name])
    announced: set[int] = set()
    for event in traced.events:
        if event["t"] == "obj_new":
            announced.add(event["obj"])
            continue
        for value in _values_in(event):
            if isinstance(value, dict) and "ref" in value:
                assert value["ref"] in announced, (
                    f"{event['t']} referenced object {value['ref']} before it was announced"
                )
        if "obj" in event and event["t"] in ("obj_set", "obj_resize", "obj_free"):
            assert event["obj"] in announced


def _values_in(event: dict[str, Any]) -> list[Any]:
    found: list[Any] = []
    for key in ("value", "prev", "return_value"):
        if key in event:
            found.append(event[key])
    for arg in event.get("args", []) or []:
        if isinstance(arg, dict) and "value" in arg:
            found.append(arg["value"])
    return found


# ---------------------------------------------------------------------------
# variables
# ---------------------------------------------------------------------------


class TestVariables:
    def test_first_binding_is_declared_and_has_no_previous_value(self) -> None:
        traced = Traced("x = 1\n")
        event = traced.one("var_set")
        assert event["declared"] is True
        assert "prev" not in event

    def test_a_rebinding_records_what_it_overwrote(self) -> None:
        traced = Traced("n = 0\nn = 5\nn = 9\n")
        sets = traced.sets_of("n")
        assert [s["value"]["prim"] for s in sets] == [0, 5, 9]
        assert [s.get("prev", {}).get("prim") for s in sets] == [None, 0, 5]

    def test_changes_are_attributed_to_the_line_that_caused_them(self) -> None:
        # Not to the line where they were noticed. Blaming the loop header for an assignment in the
        # body would show `total` changing while the `for` line is highlighted.
        traced = Traced("total = 0\nfor i in range(3):\n    total += i\n")
        body_writes = [s for s in traced.sets_of("total") if s.get("prev") is not None]
        assert body_writes, "the accumulation should be recorded"
        assert {s["line"] for s in body_writes} == {3}

    def test_rebinding_an_equal_value_is_not_reported_as_a_change(self) -> None:
        # Two separate objects holding 1000 are equal; calling that a change would litter the trace.
        traced = Traced("n = 1000\nn = 1000\nm = 1\n")
        assert len(traced.sets_of("n")) == 1

    def test_rebinding_between_equal_lists_is_reported(self) -> None:
        # Equal but distinct objects. The binding genuinely moved to a different object.
        traced = Traced("a = [1]\na = [1]\n")
        assert len(traced.sets_of("a")) == 2

    def test_a_large_integer_survives_as_a_string(self) -> None:
        traced = Traced("n = 2 ** 80\n")
        value = traced.final("n")
        assert value["bigint"] is True
        assert value["prim"] == str(2**80)

    def test_infinities_are_named_not_dropped(self) -> None:
        traced = Traced("import math\na = math.inf\nb = -math.inf\n")
        assert traced.final("a")["prim"] == "inf"
        assert traced.final("b")["prim"] == "-inf"


# ---------------------------------------------------------------------------
# control flow
# ---------------------------------------------------------------------------


class TestControlFlow:
    def test_a_branch_records_the_condition_as_written(self) -> None:
        traced = Traced("s = 95\nif s >= 90:\n    g = 'A'\n")
        branch = traced.one("branch")
        assert branch["expr"] == "s >= 90"
        assert branch["kind"] == "if"
        assert branch["outcome"] == "taken"

    def test_a_branch_never_reports_a_value_it_did_not_observe(self) -> None:
        # settrace cannot supply the condition's value, and re-evaluating the expression could fire
        # side effects. The outcome is observed; the value is absent.
        traced = Traced("s = 1\nif s > 0:\n    g = 1\n")
        assert "result" not in traced.one("branch")

    def test_a_condition_with_a_side_effect_runs_exactly_once(self) -> None:
        # The property that forbids re-evaluation. If the tracer evaluated `q.pop()` to learn the
        # outcome, the list would lose two items instead of one.
        traced = Traced("q = [1, 2, 3]\nif q.pop():\n    taken = True\n")
        traced.assert_well_formed()
        assert traced.final("taken")["prim"] is True
        final_length = [e for e in traced.of("obj_new")][0]
        assert final_length["length"] == 3
        deletes = [e for e in traced.of("obj_set") if e["op"] == "delete"]
        assert len(deletes) == 1, "the condition must be evaluated once, not twice"

    def test_elif_is_reported_as_elif(self) -> None:
        traced = Traced("s = 72\nif s >= 90:\n    g='A'\nelif s >= 70:\n    g='B'\n")
        kinds = [b["kind"] for b in traced.of("branch")]
        assert kinds == ["if", "elif"]

    def test_a_loop_reports_each_iteration(self) -> None:
        traced = Traced("t = 0\nfor i in range(5):\n    t += i\n")
        assert len(traced.of("loop_iter")) == 5
        assert traced.one("loop_exit")["iterations"] == 5
        assert traced.final("t")["prim"] == 10

    @pytest.mark.parametrize(
        ("source", "expected"),
        [
            ("for i in range(9):\n    if i == 3:\n        break\n", "break"),
            ("for i in range(9):\n    if i == 3:\n        break\nafter = 1\n", "break"),
            ("n = 0\nwhile n < 3:\n    n += 1\n", "condition"),
            ("n = 0\nwhile n < 3:\n    n += 1\nafter = 1\n", "condition"),
            ("def f(v):\n    for x in v:\n        return x\nr = f([7])\n", "return"),
            ("for i in range(3):\n    raise ValueError('x')\n", "exception"),
        ],
    )
    def test_a_loop_says_why_it_ended(self, source: str, expected: str) -> None:
        # A loop ending by break, by return or by exception never re-evaluates its header, so each
        # cause has to be reconstructed. Every one of these was wrong at first.
        traced = Traced(source)
        assert traced.one("loop_exit")["reason"] == expected

    def test_break_and_continue_are_recorded_as_jumps(self) -> None:
        traced = Traced("for i in range(4):\n    if i == 1:\n        continue\n    if i == 3:\n        break\n")
        kinds = [j["kind"] for j in traced.of("jump")]
        assert "continue" in kinds
        assert "break" in kinds

    def test_nested_loops_open_and_close_every_region(self) -> None:
        traced = Traced("p = 0\nfor i in range(3):\n    for j in range(2):\n        p += 1\n")
        enters = traced.of("loop_enter")
        exits = traced.of("loop_exit")
        # The inner loop starts afresh on each outer iteration: one outer region, three inner.
        assert len(enters) == 4
        assert len(exits) == len(enters)
        assert {e["region"] for e in exits} == {e["region"] for e in enters}
        assert traced.final("p")["prim"] == 6


# ---------------------------------------------------------------------------
# frames
# ---------------------------------------------------------------------------


class TestFrames:
    def test_a_call_records_its_arguments_and_return_value(self) -> None:
        traced = Traced("def add(a, b):\n    return a + b\nr = add(3, 4)\n")
        push = [e for e in traced.of("frame_push") if e["func"] == "add"][0]
        assert [a["name"] for a in push["args"]] == ["a", "b"]
        assert [a["value"]["prim"] for a in push["args"]] == [3, 4]
        pop = [e for e in traced.of("frame_pop") if e["frame"] == push["frame"]][0]
        assert pop["return_value"]["prim"] == 7

    def test_recursion_gives_every_depth_its_own_frame(self) -> None:
        traced = Traced("def f(n):\n    if n <= 1:\n        return 1\n    return n * f(n-1)\nr = f(4)\n")
        pushes = [e for e in traced.of("frame_push") if e["func"] == "f"]
        assert [e["recursion_depth"] for e in pushes] == [0, 1, 2, 3]
        assert len({e["frame"] for e in pushes}) == 4
        assert traced.final("r")["prim"] == 24

    def test_the_caller_chain_is_recorded(self) -> None:
        traced = Traced("def a():\n    return b()\ndef b():\n    return 1\nr = a()\n")
        pushes = {e["func"]: e for e in traced.of("frame_push")}
        assert pushes["b"]["caller"] == pushes["a"]["frame"]
        assert pushes["a"]["caller"] == pushes["<module>"]["frame"]

    def test_frames_are_balanced_even_when_a_budget_stops_the_run(self) -> None:
        # A stopped run unwinds without return events, and a replayable trace needs balanced frames.
        traced = Traced(
            "def deep(n):\n    return deep(n+1)\ndeep(0)\n", limits=Limits(max_steps=120)
        )
        traced.assert_well_formed()
        assert len(traced.of("frame_push")) == len(traced.of("frame_pop"))


# ---------------------------------------------------------------------------
# the heap
# ---------------------------------------------------------------------------


class TestHeap:
    def test_two_names_for_one_list_share_an_id(self) -> None:
        traced = Traced("a = [1, 2]\nb = a\n")
        assert traced.final("a") == traced.final("b")
        assert len(traced.of("obj_new")) == 1

    def test_a_mutation_through_an_alias_is_reported_once(self) -> None:
        traced = Traced("a = [1]\nb = a\nb.append(2)\n")
        appends = [e for e in traced.of("obj_set") if e["op"] == "append"]
        assert len(appends) == 1
        assert appends[0]["value"]["prim"] == 2

    def test_construction_is_attributed_to_the_line_that_built_it(self) -> None:
        # Not to whichever later line first triggered a walk, which would make the list look empty
        # when stepping through the lines in between.
        traced = Traced("first = [1, 2, 3]\nsecond = first\nsecond.append(4)\n")
        initial = [e for e in traced.of("obj_set") if e["key"] in ("0", "1", "2")]
        assert initial, "the list's initial contents must be recorded"
        assert {e["line"] for e in initial} == {1}

    def test_an_element_assignment_records_its_previous_value(self) -> None:
        traced = Traced("v = [1, 2, 3]\nv[1] = 99\n")
        changed = [e for e in traced.of("obj_set") if e["key"] == "1" and "prev" in e]
        assert changed
        assert changed[-1]["value"]["prim"] == 99
        assert changed[-1]["prev"]["prim"] == 2

    def test_a_nested_structure_is_followed(self) -> None:
        traced = Traced("g = [[1, 2], [3, 4]]\ng[0][1] = 9\n")
        traced.assert_well_formed()
        # Outer list plus two inner lists.
        assert len(traced.of("obj_new")) >= 3

    def test_a_linked_structure_is_connected_by_references(self) -> None:
        traced = Traced(
            "class N:\n    def __init__(self, v):\n        self.v = v\n        self.next = None\n"
            "h = N(1)\nh.next = N(2)\n"
        )
        traced.assert_well_formed()
        nexts = [e for e in traced.of("obj_set") if e["key"] == "next" and "ref" in e["value"]]
        assert nexts, "one node must end up referring to another"

    def test_an_instance_is_classified_as_an_instance(self) -> None:
        traced = Traced("class P:\n    def __init__(self, v):\n        self.v = v\np = P(7)\n")
        kinds = {e["kind"] for e in traced.of("obj_new")}
        assert "instance" in kinds

    def test_mutation_by_an_opaque_call_is_still_observed(self) -> None:
        # sort() happens entirely inside C code, so no frames appear for it. The resulting change
        # must still show up, or the list would silently reorder itself with no explanation.
        traced = Traced("v = [3, 1, 2]\nv.sort()\n")
        traced.assert_well_formed()
        after_sort = [e for e in traced.of("obj_set") if e["line"] == 2]
        assert after_sort, "the reordering must be recorded"


# ---------------------------------------------------------------------------
# exceptions
# ---------------------------------------------------------------------------


class TestExceptions:
    def test_a_caught_exception_is_raised_once_and_caught_once(self) -> None:
        traced = Traced("try:\n    1 / 0\nexcept ZeroDivisionError:\n    r = None\n")
        assert traced.one("exception_raise")["type"] == "ZeroDivisionError"
        assert traced.one("exception_catch")["handler_line"] == 3

    def test_an_exception_crossing_frames_is_reported_once(self) -> None:
        # settrace fires in every frame the exception passes through; each is the same failure still
        # travelling, not a new one.
        traced = Traced(
            "def a():\n    raise RuntimeError('x')\ndef b():\n    a()\n"
            "try:\n    b()\nexcept RuntimeError:\n    r = 'caught'\n"
        )
        assert len(traced.of("exception_raise")) == 1
        assert len(traced.of("exception_catch")) == 1
        assert traced.final("r")["prim"] == "caught"

    def test_a_return_after_a_caught_exception_is_not_misreported(self) -> None:
        # The unwinding flag used never to reset, so every later return claimed to be an exception
        # and discarded its value.
        traced = Traced(
            "try:\n    1 / 0\nexcept ZeroDivisionError:\n    pass\n"
            "def later():\n    return 42\nr = later()\n"
        )
        pop = [e for e in traced.of("frame_pop") if e.get("return_value", {}).get("prim") == 42]
        assert pop, "the later call must report its return value"
        assert pop[0]["reason"] == "return"

    def test_an_uncaught_exception_ends_the_run_but_keeps_the_trace(self) -> None:
        traced = Traced("v = [1, 2]\nprint(v[9])\n")
        traced.assert_well_formed()
        assert traced.status == "error"
        assert traced.one("run_end")["status"] == "error"
        assert traced.one("exception_uncaught")["type"] == "IndexError"
        # The list built before the failure is still there to inspect.
        assert traced.of("obj_new")

    def test_the_traceback_contains_only_the_user_program(self) -> None:
        # The tracer sits between the interpreter and the program, so its own frame is at the top of
        # every traceback. Showing it would present flow_view's internals as the user's failure.
        traced = Traced("def boom():\n    raise ValueError('nope')\nboom()\n")
        stack = traced.one("exception_uncaught")["stack"]
        assert stack
        assert all(entry["path"] == "main.py" for entry in stack), stack
        assert all("tracer" not in entry["func"] for entry in stack)

    def test_a_syntax_error_is_reported_rather_than_raised(self) -> None:
        traced = Traced("def broken(\n")
        traced.assert_well_formed()
        assert traced.status == "error"
        assert any("parse" in note["text"].lower() for note in traced.of("note"))


# ---------------------------------------------------------------------------
# limits
# ---------------------------------------------------------------------------


class TestLimits:
    def test_an_infinite_loop_is_stopped_and_the_partial_trace_is_usable(self) -> None:
        traced = Traced("n = 0\nwhile True:\n    n += 1\n", limits=Limits(max_steps=200))
        traced.assert_well_formed()
        assert traced.status == "step_limit"
        assert traced.one("run_end")["status"] == "step_limit"
        assert traced.final("n")["prim"] > 0
        assert any(note["level"] == "warn" for note in traced.of("note"))

    def test_the_stop_is_never_shown_as_an_error_in_the_program(self) -> None:
        # The budget is enforced by raising into the program. That mechanism must not surface as an
        # exception the user's code appears to have raised.
        traced = Traced("while True:\n    pass\n", limits=Limits(max_steps=60))
        assert traced.of("exception_raise") == []
        assert traced.of("exception_uncaught") == []

    def test_runaway_allocation_is_stopped(self) -> None:
        traced = Traced(
            "acc = []\nwhile True:\n    acc.append('x' * 50)\n", limits=Limits(max_steps=150)
        )
        traced.assert_well_formed()
        assert traced.status == "step_limit"

    def test_output_beyond_the_cap_is_dropped_with_a_warning(self) -> None:
        traced = Traced(
            "for i in range(200):\n    print('x' * 100)\n",
            limits=Limits(max_steps=5000, output_bytes=500),
        )
        traced.assert_well_formed()
        total = sum(len(e["text"]) for e in traced.of("stdout"))
        assert total <= 600
        assert any("Output passed" in note["text"] for note in traced.of("note"))

    def test_limits_are_published_in_the_header(self) -> None:
        traced = Traced("x = 1\n", limits=Limits(max_steps=99))
        assert traced.header["session"]["limits"]["max_steps"] == 99


# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------


class TestOutput:
    def test_output_is_attributed_to_the_line_that_printed_it(self) -> None:
        traced = Traced("print('a')\nprint('b')\n")
        lines = [e["line"] for e in traced.of("stdout") if e["text"].strip()]
        assert lines == [1, 2]

    def test_stderr_is_kept_separate(self) -> None:
        traced = Traced("import sys\nsys.stderr.write('bad\\n')\nprint('good')\n")
        assert any("bad" in e["text"] for e in traced.of("stderr"))
        assert any("good" in e["text"] for e in traced.of("stdout"))

    def test_output_order_is_preserved(self) -> None:
        traced = Traced("for i in range(3):\n    print(i)\n")
        printed = "".join(e["text"] for e in traced.of("stdout"))
        assert printed == "0\n1\n2\n"


# ---------------------------------------------------------------------------
# the library boundary
# ---------------------------------------------------------------------------


class TestLibraryBoundary:
    def test_library_frames_are_marked_opaque(self) -> None:
        traced = Traced("import json\nr = json.dumps({'a': 1})\n")
        library = [e for e in traced.of("frame_push") if e["kind"] == "library"]
        assert library, "a pure-Python library call should appear as an opaque frame"

    def test_no_line_steps_are_recorded_inside_a_library(self) -> None:
        # Stepping through json's internals would bury the user's own two lines.
        traced = Traced("import json\nr = json.dumps({'a': 1})\n")
        library_frames = {e["frame"] for e in traced.of("frame_push") if e["kind"] == "library"}
        inside = [e for e in traced.of("step_line") if e["frame"] in library_frames]
        assert inside == []

    def test_user_frames_are_marked_as_user_code(self) -> None:
        traced = Traced("def mine():\n    return 1\nr = mine()\n")
        mine = [e for e in traced.of("frame_push") if e["func"] == "mine"][0]
        assert mine["kind"] == "user"


# ---------------------------------------------------------------------------
# performance
# ---------------------------------------------------------------------------


class TestPerformance:
    def test_per_step_cost_stays_inside_the_budget(self) -> None:
        # NFR-3, as corrected by measurement: 100µs per step, and independent of heap size.
        import time

        source = (
            "nodes = []\n"
            "for i in range(300):\n"
            "    nodes.append({'i': i, 'sq': i * i})\n"
            "total = 0\n"
            "for n in nodes:\n"
            "    total += n['sq']\n"
        )
        started = time.perf_counter()
        traced = Traced(source, limits=Limits(max_steps=50_000))
        elapsed_us = (time.perf_counter() - started) * 1e6
        steps = traced.one("run_end")["steps"]
        assert steps > 500
        per_step = elapsed_us / steps
        assert per_step < 250, f"{per_step:.0f}µs per step, including interpreter overhead"

    def test_cost_does_not_grow_with_heap_size(self) -> None:
        # The property the whole walk strategy exists for.
        import time

        def measure(count: int) -> float:
            source = (
                f"data = [ {{'v': i}} for i in range({count}) ]\n"
                "total = 0\n"
                "for i in range(40):\n"
                "    total += i\n"
            )
            started = time.perf_counter()
            traced = Traced(source, limits=Limits(max_steps=50_000))
            steps = traced.one("run_end")["steps"]
            return (time.perf_counter() - started) * 1e6 / max(1, steps)

        small = measure(100)
        large = measure(2_000)
        assert large < small * 4, (
            f"{small:.0f}µs/step at 100 objects vs {large:.0f}µs/step at 2000 — "
            "per-step cost must not scale with the heap"
        )
