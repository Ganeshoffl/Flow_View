"""Folding a long loop without lying about it.

The property that matters is not "fewer events". It is that a collapsed trace and an uncollapsed one
describe the *same run*: replaying either leaves identical state, and stepping backward across a fold
lands exactly where stepping backward through the iterations would have.

So most of these tests replay both and compare, rather than asserting on the shape of the output. The
shape is an implementation detail; agreement is the contract.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "packages/trace-schema/python"))

from flow_view_schema import check_trace_invariants, validate_trace  # noqa: E402
from flow_view_tracer.collapse import LoopCollapser  # noqa: E402
from flow_view_tracer.emit import Limits  # noqa: E402
from flow_view_tracer.tracer import TracerOptions, run_source  # noqa: E402


def trace(source: str, *, collapse: dict[str, int] | None = None) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    header: dict[str, Any] = {}

    def sink(event: dict[str, Any]) -> None:
        if "session" in event:
            header.update(event)
        else:
            events.append(event)

    options = TracerOptions(collapse=collapse) if collapse is not None else TracerOptions()
    run_source(source, "main.py", on_event=sink, options=options, limits=Limits(max_steps=5_000_000))
    _documents[id(events)] = {
        "schema": header.get("schema"),
        "session": header.get("session"),
        "events": events,
    }
    return events


#: Assembled trace documents, so a test can validate the whole thing and not just its events.
_documents: dict[int, dict[str, Any]] = {}


def document_of(events: list[dict[str, Any]]) -> dict[str, Any]:
    return _documents[id(events)]


# ---------------------------------------------------------------- replaying

def replay(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Apply a trace the way the TraceStore does, and report the state it ends in.

    Deliberately a second, independent implementation of the same semantics. If the collapser and this
    disagree with the real store, the crosscheck suite in TypeScript says so; if the collapser
    disagrees with *itself* between a folded and an unfolded run, this says so here, in the language
    the bug would be in.
    """
    variables: dict[tuple[Any, Any], Any] = {}
    objects: dict[int, dict[str, Any]] = {}
    metrics: dict[str, int] = {}
    output: list[str] = []

    for event in events:
        kind = event["t"]
        if kind == "var_set":
            variables[(event.get("frame"), event["name"])] = event["value"]
        elif kind == "var_del":
            variables.pop((event.get("frame"), event["name"]), None)
        elif kind == "obj_new":
            objects.setdefault(event["obj"], {})
        elif kind == "obj_set":
            objects.setdefault(event["obj"], {})[str(event["key"])] = event["value"]
        elif kind == "metric":
            metrics[event["name"]] = metrics.get(event["name"], 0) + int(event.get("delta", 1))
        elif kind == "stdout":
            output.append(event["text"])
        elif kind == "collapse":
            for effect in event["effects"]:
                if effect["kind"] == "var":
                    key = (effect.get("frame"), effect["key"])
                    if "after" in effect:
                        variables[key] = effect["after"]
                    else:
                        variables.pop(key, None)
                else:
                    slots = objects.setdefault(effect["obj"], {})
                    if "after" in effect:
                        slots[effect["key"]] = effect["after"]
                    else:
                        slots.pop(effect["key"], None)
            for name, delta in (event.get("metrics") or {}).items():
                metrics[name] = metrics.get(name, 0) + int(delta)

    return {"variables": variables, "objects": objects, "metrics": metrics, "output": "".join(output)}


def invert(events: list[dict[str, Any]], state: dict[str, Any]) -> dict[str, Any]:
    """Undo a trace, so a fold can be checked to be reversible and not merely summarising."""
    variables = dict(state["variables"])
    objects = {k: dict(v) for k, v in state["objects"].items()}

    for event in reversed(events):
        kind = event["t"]
        if kind == "var_set":
            key = (event.get("frame"), event["name"])
            if "prev" in event:
                variables[key] = event["prev"]
            else:
                variables.pop(key, None)
        elif kind == "obj_set":
            slots = objects.setdefault(event["obj"], {})
            if "prev" in event:
                slots[str(event["key"])] = event["prev"]
            else:
                slots.pop(str(event["key"]), None)
        elif kind == "collapse":
            for effect in event["effects"]:
                if effect["kind"] == "var":
                    key = (effect.get("frame"), effect["key"])
                    if "before" in effect:
                        variables[key] = effect["before"]
                    else:
                        variables.pop(key, None)
                else:
                    slots = objects.setdefault(effect["obj"], {})
                    if "before" in effect:
                        slots[effect["key"]] = effect["before"]
                    else:
                        slots.pop(effect["key"], None)

    return {"variables": variables, "objects": objects}


# ---------------------------------------------------------------- the unit

class TestTheCollapserAlone:
    def build(self, iterations: int, **kwargs: Any) -> list[tuple[str, dict[str, Any]]]:
        """Drive a collapser with a synthetic `total += i` loop and return what it emitted."""
        c = LoopCollapser(**kwargs)
        out: list[tuple[str, dict[str, Any]]] = []
        out += c.feed("loop_enter", {"region": 1, "line_start": 2, "line_end": 3})
        total = 0
        for i in range(iterations):
            out += c.feed("loop_iter", {"region": 1, "i": i})
            out += c.feed("step_line", {"frame": 0, "line": 3, "path": "main.py"})
            out += c.feed(
                "var_set",
                {"frame": 0, "name": "i", "value": {"prim": i}, "prev": {"prim": i - 1}},
            )
            before, total = total, total + i
            out += c.feed(
                "var_set",
                {
                    "frame": 0,
                    "name": "total",
                    "value": {"prim": total},
                    "prev": {"prim": before},
                },
            )
            out += c.feed("metric", {"name": "iteration", "delta": 1})
        out += c.feed("loop_exit", {"region": 1, "iterations": iterations, "reason": "condition"})
        out += c.drain()
        return out

    def test_a_short_loop_is_left_alone(self) -> None:
        out = self.build(10, min_iterations=20)
        assert [k for k, _ in out].count("collapse") == 0
        assert [k for k, _ in out].count("loop_iter") == 10

    def test_a_long_loop_is_folded_in_the_middle(self) -> None:
        out = self.build(1000, keep_head=3, keep_tail=3, min_iterations=20)
        kinds = [k for k, _ in out]
        folded = sum(p["iterations"] for k, p in out if k == "collapse")
        assert kinds.count("loop_iter") + folded == 1000, "every iteration is accounted for"
        assert kinds.count("collapse") >= 1
        assert folded > 900, f"only {folded} of 1000 were folded"

    def test_the_head_and_tail_survive_verbatim(self) -> None:
        out = self.build(1000, keep_head=3, keep_tail=3, min_iterations=20)
        kept = [p["i"] for k, p in out if k == "loop_iter"]
        # The head is exact. The tail is the last few, whatever the chunking worked out to.
        assert kept[:3] == [0, 1, 2]
        assert kept[-3:] == [997, 998, 999]

    def test_the_fold_records_which_iterations_it_swallowed(self) -> None:
        out = self.build(500, keep_head=2, keep_tail=2, min_iterations=0, chunk=10_000)
        folds = [p for k, p in out if k == "collapse"]
        assert len(folds) == 1
        # Expand-on-demand re-runs a range of iterations, and cannot use seq numbers to do it.
        assert folds[0]["from_iter"] == 2
        assert folds[0]["to_iter"] == 496
        assert folds[0]["iterations"] == 495

    def test_the_net_effect_is_the_first_before_and_the_last_after(self) -> None:
        out = self.build(500, keep_head=2, keep_tail=2, min_iterations=0, chunk=10_000)
        fold = next(p for k, p in out if k == "collapse")
        total = next(e for e in fold["effects"] if e["key"] == "total")
        # Iterations 2..496 are folded, so `total` starts having accumulated 0+1 and ends at sum(0..496).
        assert total["before"] == {"prim": 1}
        assert total["after"] == {"prim": sum(range(497))}

    def test_metrics_are_summed_rather_than_dropped(self) -> None:
        out = self.build(500, keep_head=2, keep_tail=2, min_iterations=0, chunk=10_000)
        fold = next(p for k, p in out if k == "collapse")
        assert fold["metrics"]["iteration"] == 495

    def test_chunking_keeps_the_stream_moving(self) -> None:
        # A single fold for a million iterations would mean emitting nothing for the whole loop.
        out = self.build(1000, keep_head=3, keep_tail=3, min_iterations=20, chunk=100)
        assert sum(1 for k, _ in out if k == "collapse") >= 9

    def test_memory_does_not_grow_with_the_loop(self) -> None:
        c = LoopCollapser(keep_head=2, keep_tail=2, min_iterations=10, chunk=50)
        c.feed("loop_enter", {"region": 1, "line_start": 2, "line_end": 3})
        widths = []
        for i in range(5000):
            c.feed("loop_iter", {"region": 1, "i": i})
            c.feed("var_set", {"frame": 0, "name": "t", "value": {"prim": i}, "prev": {"prim": i - 1}})
            if i % 1000 == 0:
                held = sum(len(it) for it in c._stack[-1].tail)
                held += len(c._stack[-1].current or [])
                widths.append(held)
        assert max(widths) <= 20, f"buffering grew with the loop: {widths}"


class TestWhatAFoldRefusesToSwallow:
    """Correctness before compression.

    A fold can represent variable and heap writes and nothing else. Anything that is visible behaviour
    in its own right must survive, so a span containing one is not folded at all.
    """

    def run_with(self, extra_kind: str, extra_payload: dict[str, Any]) -> list[tuple[str, dict]]:
        c = LoopCollapser(keep_head=1, keep_tail=1, min_iterations=2)
        out: list[tuple[str, dict[str, Any]]] = []
        out += c.feed("loop_enter", {"region": 1, "line_start": 2, "line_end": 3})
        for i in range(50):
            out += c.feed("loop_iter", {"region": 1, "i": i})
            out += c.feed("var_set", {"frame": 0, "name": "i", "value": {"prim": i}})
            if i == 20:
                out += c.feed(extra_kind, extra_payload)
        out += c.feed("loop_exit", {"region": 1, "iterations": 50, "reason": "condition"})
        out += c.drain()
        return out

    @pytest.mark.parametrize(
        ("kind", "payload"),
        [
            ("stdout", {"text": "hello\n"}),
            ("stderr", {"text": "oops\n"}),
            ("stdin_request", {"prompt": "more? "}),
            ("exception_raise", {"type": "ValueError", "message": "no", "frame": 0}),
            ("obj_new", {"obj": 7, "kind": "list", "type_name": "list"}),
            ("note", {"level": "warn", "text": "something"}),
        ],
    )
    def test_it_is_never_swallowed(self, kind: str, payload: dict[str, Any]) -> None:
        out = self.run_with(kind, payload)
        assert any(k == kind for k, _ in out), f"{kind} was lost in a fold"

    def test_every_iteration_still_appears_once_folding_is_abandoned(self) -> None:
        out = self.run_with("stdout", {"text": "hi\n"})
        kinds = [k for k, _ in out]
        folded = sum(p["iterations"] for k, p in out if k == "collapse")
        assert kinds.count("loop_iter") + folded == 50

    def test_output_keeps_its_place_in_the_order(self) -> None:
        out = self.run_with("stdout", {"text": "hi\n"})
        kinds = [k for k, _ in out]
        printed = kinds.index("stdout")
        # It has to land after the iteration it happened in, not be hoisted to the end of the loop.
        assert kinds[printed - 1] == "var_set"
        assert "loop_exit" in kinds[printed:]


# ---------------------------------------------------------------- end to end

class TestATracedProgramMeansTheSameThingEitherWay:
    PROGRAMS = {
        "accumulate": "total = 0\nfor i in range(400):\n    total += i\n",
        "two variables": (
            "a = 0\nb = 1\nfor i in range(300):\n    a = a + i\n    b = b * 2 % 9973\n"
        ),
        "nested": (
            "grid = 0\nfor i in range(40):\n    for j in range(30):\n        grid += i * j\n"
        ),
        "mutating a list": (
            "xs = [0, 0, 0]\nfor i in range(300):\n    xs[i % 3] = xs[i % 3] + i\n"
        ),
        "while loop": "n = 0\nwhile n < 250:\n    n = n + 1\n",
        "conditional inside": (
            "evens = 0\nodds = 0\nfor i in range(300):\n"
            "    if i % 2 == 0:\n        evens += 1\n    else:\n        odds += 1\n"
        ),
    }

    @pytest.mark.parametrize("name", sorted(PROGRAMS))
    def test_the_final_state_is_identical(self, name: str) -> None:
        source = self.PROGRAMS[name]
        plain = trace(source)
        folded = trace(source, collapse={"keep_head": 3, "keep_tail": 3, "min_iterations": 10})

        expected = replay(plain)
        actual = replay(folded)
        assert actual["variables"] == expected["variables"], name
        assert actual["objects"] == expected["objects"], name
        assert actual["output"] == expected["output"], name

    @pytest.mark.parametrize("name", sorted(PROGRAMS))
    def test_metrics_survive_the_fold(self, name: str) -> None:
        source = self.PROGRAMS[name]
        plain = replay(trace(source))["metrics"]
        folded = replay(
            trace(source, collapse={"keep_head": 3, "keep_tail": 3, "min_iterations": 10})
        )["metrics"]
        # Folding discards *steps*, not work. A summary that under-reported the work done would make
        # the metrics pane lie about how expensive the program was.
        assert folded == plain, name

    @pytest.mark.parametrize("name", sorted(PROGRAMS))
    def test_undoing_the_whole_trace_gets_back_to_nothing(self, name: str) -> None:
        source = self.PROGRAMS[name]
        folded = trace(source, collapse={"keep_head": 3, "keep_tail": 3, "min_iterations": 10})
        end = replay(folded)
        start = invert(folded, end)
        assert start["variables"] == {}, f"{name} left {start['variables']} behind"
        for obj, slots in start["objects"].items():
            assert slots == {}, f"{name} left object {obj} holding {slots}"

    @pytest.mark.parametrize("name", sorted(PROGRAMS))
    def test_the_folded_trace_is_still_valid(self, name: str) -> None:
        folded = trace(
            self.PROGRAMS[name], collapse={"keep_head": 3, "keep_tail": 3, "min_iterations": 10}
        )
        document = document_of(folded)
        shape = validate_trace(document)
        assert shape.valid, f"{name} is not schema-valid: {shape.describe()}"
        coherence = check_trace_invariants(document)
        assert coherence.valid, f"{name} is not coherent: {coherence.describe()}"

    def test_folding_actually_reduces_the_trace(self) -> None:
        source = "total = 0\nfor i in range(2000):\n    total += i\n"
        plain = trace(source)
        folded = trace(source, collapse={"keep_head": 3, "keep_tail": 3, "min_iterations": 10})
        assert len(folded) < len(plain) / 5, (
            f"{len(folded)} events against {len(plain)} - folding bought almost nothing"
        )

    def test_steps_are_numbered_densely(self) -> None:
        # A fold must not leave holes: "step 400 of 20" is nonsense, and the playhead indexes by step.
        folded = trace(
            "total = 0\nfor i in range(500):\n    total += i\n",
            collapse={"keep_head": 3, "keep_tail": 3, "min_iterations": 10},
        )
        steps = [e["step"] for e in folded if "step" in e]
        assert steps == list(range(len(steps))), "step numbering has holes"

    def test_a_program_that_prints_every_iteration_keeps_all_its_output(self) -> None:
        source = "for i in range(200):\n    print(i)\n"
        plain = replay(trace(source))["output"]
        folded = replay(
            trace(source, collapse={"keep_head": 2, "keep_tail": 2, "min_iterations": 5})
        )["output"]
        assert folded == plain
        assert folded.count("\n") == 200
