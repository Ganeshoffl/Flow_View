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



class TestTheGarbageCollectorIsNotTheProgram:
    """Finalizers belong to the interpreter, not to the program being traced.

    This is the bug behind an intermittent 90-against-60 disagreement that was blamed on the backends
    for two phases. `sys.monitoring` is global, and a frame is admitted when its caller is already
    known - so a `__del__` firing mid-statement, on an object the program had never touched, was
    reported as a call the program made, along with everything it called. `settrace` spends long enough
    inside its own callbacks that collection usually happened *there*, where tracing is suppressed, so
    it mostly did not see them. Hence a disagreement that came and went with unrelated garbage.

    Reproduced here on purpose rather than opportunistically. An earlier version of these tests dropped
    garbage and called `gc.collect()` before tracing, which collected it before the traced run began:
    the tests passed with the fix reverted, which makes them worse than no tests. The program below
    forces a synchronous collection of a cycle whose class lives outside the user's file, so the
    finalizer is guaranteed to run inside the traced region.
    """

    @pytest.fixture
    def foreign_library(self, tmp_path: Any) -> str:
        """A module that is not the user's file, with a finalizer that calls something."""
        module = tmp_path / "pretend_library.py"
        module.write_text(
            "class Handle:\n"
            "    def __del__(self):\n"
            "        self.shut()\n"
            "    def shut(self):\n"
            "        return True\n"
            "\n"
            "def make_cycle():\n"
            "    a, b = Handle(), Handle()\n"
            "    a.peer, b.peer = b, a\n",
            encoding="utf-8",
        )
        sys.path.insert(0, str(tmp_path))
        try:
            yield str(tmp_path)
        finally:
            sys.path.remove(str(tmp_path))
            sys.modules.pop("pretend_library", None)

    SOURCE = (
        "import gc\n"
        "import pretend_library\n"
        "for i in range(5):\n"
        "    pretend_library.make_cycle()\n"
        "gc.collect()\n"
        "done = 1\n"
    )

    @pytest.mark.parametrize("backend", ["settrace", "monitoring"])
    def test_a_foreign_finalizer_is_not_the_programs_own_work(
        self, backend: str, foreign_library: str
    ) -> None:
        if backend == "monitoring" and not monitoring_available():
            pytest.skip("sys.monitoring needs Python 3.12+")
        names = [e["func"] for e in trace(self.SOURCE, backend) if e["t"] == "frame_push"]
        assert "__del__" not in names, f"{backend} reported a finalizer as a call the program made"
        # And everything underneath it. Refusing the finalizer alone left `shut` behind, because the
        # two backends do not agree on how a frame becomes known.
        assert "shut" not in names, f"{backend} reported a finalizer's callee"

    @needs_monitoring
    def test_the_backends_agree_about_it(self, foreign_library: str) -> None:
        def finalizer_frames(backend: str) -> dict[str, int]:
            events = trace(self.SOURCE, backend)
            return _by_func(
                [
                    e
                    for e in events
                    if e["t"] == "frame_push" and e["func"] in ("__del__", "shut")
                ]
            )

        assert finalizer_frames("monitoring") == finalizer_frames("settrace") == {}

    def test_a_finalizer_the_user_wrote_is_still_their_code(self) -> None:
        # The fix refuses *foreign* finalizers only. A `__del__` in the user's own file is theirs, and
        # the surprise of when it runs is worth showing rather than hiding.
        from flow_view_tracer.tracer import Tracer

        tracer = Tracer.__new__(Tracer)
        tracer.path = "/somewhere/main.py"
        tracer._frames = {}

        class Code:
            co_name = "__del__"
            co_filename = "/somewhere/main.py"

        class Frame:
            f_code = Code()
            f_back = None

        assert not Tracer._is_foreign_finalizer(tracer, Frame()), "the user's own __del__ was refused"
        Code.co_filename = "/usr/lib/python3.12/codecs.py"
        assert Tracer._is_foreign_finalizer(tracer, Frame()), "a library __del__ was allowed through"
