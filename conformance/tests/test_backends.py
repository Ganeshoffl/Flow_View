"""Pinning the relationship between the two tracing backends.

Two things are asserted, and the second matters as much as the first: that the backends agree
everywhere they can, **and** that they diverge on exactly the constructs recorded in
``docs/decisions/0002-tracing-backend.md``.

Pinning the known divergence means a change in CPython's `LINE` semantics shows up as a failing test
with a decision document to read, rather than as a user wondering why their comprehension has a
different number of steps than a tutorial shows.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

CONFORMANCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CONFORMANCE))
sys.path.insert(0, str(CONFORMANCE.parent / "adapters" / "python"))

from backends import AGREEING, DIVERGING, first_difference, step_count, trace  # noqa: E402

from flow_view_tracer.backends import (  # noqa: E402
    SettraceBackend,
    choose_backend,
    monitoring_available,
)

needs_monitoring = pytest.mark.skipif(
    not monitoring_available(), reason="sys.monitoring needs Python 3.12+"
)


def _by_func(frames: list[dict[str, object]]) -> dict[str, int]:
    """Frame counts per function name, for a failure message that explains itself."""
    import collections

    return dict(collections.Counter(str(f["func"]) for f in frames))


class TestDefault:
    def test_settrace_is_the_default_on_every_version(self) -> None:
        # Not a per-version choice. The same program must trace the same way on 3.10 and on 3.14, or a
        # user following a tutorial sees step counts that do not match and has no way to know why.
        assert isinstance(choose_backend("auto"), SettraceBackend)

    def test_a_backend_can_still_be_demanded(self) -> None:
        assert choose_backend("settrace").name == "settrace"
        assert choose_backend("monitoring").name == "monitoring"

    def test_an_unknown_backend_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="unknown backend"):
            choose_backend("magic")


@needs_monitoring
@pytest.mark.parametrize("name", sorted(AGREEING))
def test_the_backends_agree(name: str) -> None:
    settrace = trace(AGREEING[name], "settrace")
    monitoring = trace(AGREEING[name], "monitoring")
    assert settrace == monitoring, (
        f"{name} traced differently by the two backends:\n  {first_difference(settrace, monitoring)}"
    )


@needs_monitoring
@pytest.mark.parametrize("name", sorted(DIVERGING))
def test_the_known_divergence_still_looks_exactly_like_this(name: str) -> None:
    # Monitoring's LINE event fires on a line transition, so a loop written on one line is a single
    # step. If this ever stops being true, the decision that settrace is the default should be
    # revisited, and this test is the notification.
    settrace = trace(DIVERGING[name], "settrace")
    monitoring = trace(DIVERGING[name], "monitoring")
    assert step_count(settrace) > step_count(monitoring), (
        f"{name} no longer diverges. sys.monitoring may have changed; "
        "re-read docs/decisions/0002-tracing-backend.md"
    )


@needs_monitoring
class TestMonitoringCorrectness:
    def test_repeated_library_calls_are_every_one_reported(self) -> None:
        # The bug that made monitoring look 5x faster: DISABLE is permanent per code location, so
        # disabling PY_START for json.dumps meant only the first of eighty calls was ever seen.
        source = (
            "import json\nout = []\nfor i in range(20):\n    out.append(json.dumps({'i': i}))\n"
        )
        settrace = trace(source, "settrace")
        monitoring = trace(source, "monitoring")
        library_settrace = [
            e for e in settrace if e["t"] == "frame_push" and e.get("kind") == "library"
        ]
        library_monitoring = [
            e for e in monitoring if e["t"] == "frame_push" and e.get("kind") == "library"
        ]
        # Report *which* frames differ, not just how many.
        #
        # This has been seen to fail with 90 against 60, intermittently, and only when the whole suite
        # runs in one process. It could not be pinned down, because any attempt to observe it made it
        # stop happening: tracing the same program twice immediately beforehand was enough to mask it.
        # Since it cannot be reproduced on demand, the next occurrence has to carry its own evidence.
        assert len(library_monitoring) == len(library_settrace), (
            "the backends disagree about which library frames a run enters.\n"
            f"  settrace   {len(library_settrace):4}: {_by_func(library_settrace)}\n"
            f"  monitoring {len(library_monitoring):4}: {_by_func(library_monitoring)}\n"
            "If the difference is extra _iterencode frames, json took its Python encoding path in one "
            "run and its C path in the other, and the backends are not the thing that differs."
        )
        assert len(library_monitoring) >= 20, "every call must be reported, not just the first"

    def test_no_line_steps_are_recorded_inside_library_code(self) -> None:
        source = "import json\ne = json.dumps({'a': 1})\n"
        for backend in ("settrace", "monitoring"):
            events = trace(source, backend)
            library = {
                e["frame"] for e in events if e["t"] == "frame_push" and e.get("kind") == "library"
            }
            inside = [e for e in events if e["t"] == "step_line" and e.get("frame") in library]
            assert inside == [], f"{backend} stepped inside library code"

    def test_neither_backend_records_the_tracer_itself(self) -> None:
        # The tracer's teardown necessarily runs while tracing is live. This caught a frame for
        # `uninstall` and a heap object for the backend at the end of every trace.
        for backend in ("settrace", "monitoring"):
            events = trace("x = 1\n", backend)
            functions = {e.get("func") for e in events if e["t"] == "frame_push"}
            assert "uninstall" not in functions
            types = {e.get("type_name") for e in events if e["t"] == "obj_new"}
            assert not any(name and "Backend" in name for name in types), (
                f"{backend} recorded its own objects: {types}"
            )

    def test_a_generator_is_described_the_same_way_by_both(self) -> None:
        # settrace calls a yield a return and a resume a call; monitoring reports them as distinct
        # events. The mapping is explicit rather than assumed.
        source = "def g():\n    yield 1\n    yield 2\nvalues = list(g())\n"
        assert trace(source, "settrace") == trace(source, "monitoring")
