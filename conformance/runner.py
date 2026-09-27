"""The conformance suite.

Every adapter runs the same corpus and is held to the same expectations. That is what makes "add a
language" mean "pass this suite" rather than "invent a dialect that happens to render".

The expectations in each ``case.json`` are deliberately **language-agnostic**. They talk about final
variable values, loop iteration counts, how an exception was handled — not about Python. When
``main.js`` appears next to ``main.py``, the same file governs both, and any disagreement between the
adapters becomes a failing test instead of a difference nobody noticed.

Three layers are checked:

1. the trace validates against the schema;
2. it satisfies the structural invariants — monotonic sequence, balanced frames, no mutation of an
   object that was never announced;
3. it says what the case says it should.

Replay and invertibility are checked separately, by the TypeScript suite, against traces this module
writes out. The TraceStore owns trace semantics and there is exactly one implementation of them;
porting it to Python to test it here would create a second one to disagree with.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
CASES = ROOT / "cases"
TRACE_OUT = ROOT / ".traces"

sys.path.insert(0, str(REPO / "adapters" / "python"))
sys.path.insert(0, str(REPO / "packages" / "trace-schema" / "python"))

from flow_view_schema import check_trace_invariants, validate_trace  # noqa: E402

#: Source file name per language, so a case directory can hold one file per adapter.
SOURCE_FILES = {
    "python": "main.py",
    "javascript": "main.js",
    "c": "main.c",
    "cpp": "main.cpp",
    "java": "Main.java",
}


@dataclass
class Case:
    """One program plus what every adapter must report about it."""

    name: str
    directory: Path
    description: str
    concepts: list[str]
    expect: dict[str, Any]

    def source_for(self, language: str) -> str | None:
        filename = SOURCE_FILES.get(language)
        if filename is None:
            return None
        path = self.directory / filename
        return path.read_text(encoding="utf-8") if path.is_file() else None

    def languages(self) -> list[str]:
        return [lang for lang in SOURCE_FILES if self.source_for(lang) is not None]


def load_cases() -> list[Case]:
    cases: list[Case] = []
    for directory in sorted(CASES.iterdir()):
        meta_path = directory / "case.json"
        if not meta_path.is_file():
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        cases.append(
            Case(
                name=meta["name"],
                directory=directory,
                description=meta.get("description", ""),
                concepts=meta.get("concepts", []),
                expect=meta.get("expect", {}),
            )
        )
    return cases


@dataclass
class Trace:
    """A completed trace, with the questions the expectations ask."""

    schema: str
    session: dict[str, Any]
    events: list[dict[str, Any]]
    status: str

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [event for event in self.events if event.get("t") == kind]

    @property
    def document(self) -> dict[str, Any]:
        return {"schema": self.schema, "session": self.session, "events": self.events}

    def stdout(self) -> str:
        return "".join(event["text"] for event in self.of("stdout"))

    def final_value(self, name: str) -> Any:
        """The last value bound to a name, decoded to a plain Python value."""
        history = [e for e in self.of("var_set") if e.get("name") == name]
        if not history:
            return _MISSING
        return _decode(history[-1]["value"], self)

    def value_history(self, name: str) -> list[Any]:
        return [_decode(e["value"], self) for e in self.of("var_set") if e.get("name") == name]

    def object_of(self, obj_id: int) -> dict[str, Any] | None:
        for event in self.of("obj_new"):
            if event["obj"] == obj_id:
                return event
        return None


class _Missing:
    def __repr__(self) -> str:
        return "<never assigned>"


_MISSING = _Missing()


def _decode(value: dict[str, Any], trace: Trace) -> Any:
    """Turn a schema value into something an expectation can compare against."""
    if "prim" in value:
        if value.get("bigint"):
            return int(value["prim"])
        return value["prim"]
    if "ref" in value:
        return _Ref(value["ref"], trace)
    if "addr" in value:
        return value["addr"]
    if "unavailable" in value:
        return _MISSING
    return None


@dataclass
class _Ref:
    obj: int
    trace: Trace

    def __eq__(self, other: object) -> bool:
        return isinstance(other, _Ref) and other.obj == self.obj

    def __repr__(self) -> str:
        info = self.trace.object_of(self.obj)
        return f"<{info['type_name'] if info else '?'} #{self.obj}>"


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------


@dataclass
class Result:
    case: str
    language: str
    failures: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.failures

    def check(self, condition: bool, message: str) -> None:
        if not condition:
            self.failures.append(message)

    def describe(self) -> str:
        if self.passed:
            return f"{self.case} [{self.language}] ok"
        lines = "\n".join(f"    - {failure}" for failure in self.failures)
        return f"{self.case} [{self.language}] FAILED\n{lines}"


def verify(case: Case, trace: Trace) -> Result:
    """Check one trace against one case."""
    result = Result(case.name, trace.session.get("language", "?"))
    expect = case.expect

    shape = validate_trace(trace.document)
    result.check(shape.valid, f"schema: {shape.describe(3)}")
    coherence = check_trace_invariants(trace.document)
    result.check(coherence.valid, f"invariants: {coherence.describe(3)}")

    if "status" in expect:
        ends = trace.of("run_end")
        actual = ends[-1]["status"] if ends else "<no run_end>"
        result.check(
            actual == expect["status"], f"status: expected {expect['status']}, got {actual}"
        )

    if "stdout" in expect:
        actual_out = trace.stdout()
        result.check(
            actual_out == expect["stdout"],
            f"stdout: expected {expect['stdout']!r}, got {actual_out!r}",
        )

    for name, wanted in (expect.get("final_variables") or {}).items():
        actual_value = trace.final_value(name)
        result.check(
            actual_value == wanted,
            f"final value of {name}: expected {wanted!r}, got {actual_value!r}",
        )

    for name, wanted_history in (expect.get("variable_history") or {}).items():
        actual_history = trace.value_history(name)
        result.check(
            actual_history == wanted_history,
            f"history of {name}: expected {wanted_history!r}, got {actual_history!r}",
        )

    if expect.get("every_rebinding_has_prev"):
        offenders = [
            event["name"]
            for event in trace.of("var_set")
            if not event.get("declared") and "prev" not in event
        ]
        result.check(
            not offenders,
            f"these rebindings did not record what they overwrote: {sorted(set(offenders))}",
        )

    _check_branches(expect, trace, result)
    _check_loops(expect, trace, result)
    _check_calls(expect, trace, result)
    _check_recursion(expect, trace, result)
    _check_exceptions(expect, trace, result)
    _check_heap(expect, trace, result)
    _check_stdin(expect, trace, result)
    _check_library(expect, trace, result)
    _check_structure(expect, trace, result)

    if "min_steps" in expect:
        steps = len([e for e in trace.events if "step" in e])
        result.check(
            steps >= expect["min_steps"], f"steps: expected at least {expect['min_steps']}, got {steps}"
        )

    for kind in expect.get("events_present", []):
        result.check(bool(trace.of(kind)), f"no {kind} event was emitted")

    for metric, minimum in (expect.get("metrics_at_least") or {}).items():
        total = sum(e["delta"] for e in trace.of("metric") if e["name"] == metric)
        # Folding a loop discards steps, not work. A collapse event carries the totals for the
        # iterations it replaced, and leaving them out here would let a folded trace under-report how
        # much the program did - which is exactly the lie the metrics pane must not tell.
        total += sum(
            int((e.get("metrics") or {}).get(metric, 0)) for e in trace.of("collapse")
        )
        result.check(total >= minimum, f"metric {metric}: expected at least {minimum}, got {total}")

    _check_collapsed(expect, trace, result)

    return result


def _check_collapsed(expect: dict[str, Any], trace: Trace, result: Result) -> None:
    """A folded trace has to admit what it folded, and stay reversible.

    Language-agnostic on purpose: every adapter that collapses loops owes the same guarantees, and an
    adapter that does not collapse at all simply has no case expecting it.
    """
    wanted = expect.get("collapsed")
    if wanted is None:
        return
    folds = trace.of("collapse")

    if wanted.get("at_least_one"):
        result.check(bool(folds), "no collapse event was emitted for a loop long enough to fold")
    if not folds:
        return

    folded = sum(f["iterations"] for f in folds)
    minimum = wanted.get("iterations_at_least")
    if minimum is not None:
        result.check(
            folded >= minimum,
            f"folded iterations: expected at least {minimum}, got {folded}",
        )

    for fold in folds:
        result.check(
            bool(fold.get("effects")),
            "a collapse event carried no effects, so stepping back over it would be guesswork",
        )
        # Invertibility is the whole contract: every effect needs an `after` to apply and a `before` to
        # undo. A slot that did not exist before is represented by `before` being absent, so only the
        # presence of one or the other is required - not both.
        for effect in fold["effects"]:
            result.check(
                "after" in effect or "before" in effect,
                f"collapse effect on {effect.get('key')!r} carries neither before nor after",
            )
            result.check(
                effect.get("kind") in ("var", "obj"),
                f"collapse effect has an unknown kind {effect.get('kind')!r}",
            )
        result.check(
            fold.get("from_iter") is not None and fold.get("to_iter") is not None,
            "a collapse event did not say which iterations it replaced, so it cannot be expanded",
        )


def _check_branches(expect: dict[str, Any], trace: Trace, result: Result) -> None:
    wanted = expect.get("branches")
    if wanted is None:
        return
    actual = trace.of("branch")
    result.check(
        len(actual) >= len(wanted),
        f"branches: expected at least {len(wanted)}, got {len(actual)}",
    )
    for index, want in enumerate(wanted):
        if index >= len(actual):
            break
        got = actual[index]
        for key, value in want.items():
            result.check(
                got.get(key) == value,
                f"branch {index} {key}: expected {value!r}, got {got.get(key)!r}",
            )
        # A condition's value is only reported where the runtime surfaces it for free. Python cannot,
        # and inventing one would mean re-evaluating the user's expression.
        if "result" not in want:
            result.check(
                "result" not in got or got["result"] is None,
                f"branch {index} reported a condition value it could not have observed",
            )


def _check_loops(expect: dict[str, Any], trace: Trace, result: Result) -> None:
    wanted = expect.get("loops")
    if wanted is None:
        return
    exits = trace.of("loop_exit")
    enters = trace.of("loop_enter")
    result.check(
        len(enters) == len(exits), f"{len(enters)} loops opened but {len(exits)} closed"
    )
    result.check(len(exits) >= len(wanted), f"loops: expected {len(wanted)}, got {len(exits)}")
    for index, want in enumerate(wanted):
        if index >= len(exits):
            break
        got = exits[index]
        for key, value in want.items():
            result.check(
                got.get(key) == value,
                f"loop {index} {key}: expected {value!r}, got {got.get(key)!r}",
            )


def _check_calls(expect: dict[str, Any], trace: Trace, result: Result) -> None:
    for want in expect.get("calls") or []:
        pushes = [e for e in trace.of("frame_push") if e.get("func") == want["func"]]
        if not pushes:
            result.failures.append(f"no call to {want['func']} was recorded")
            continue
        push = pushes[0]
        if "args" in want:
            actual_args = [_decode(a["value"], trace) for a in push.get("args", [])]
            result.check(
                actual_args == want["args"],
                f"{want['func']} arguments: expected {want['args']!r}, got {actual_args!r}",
            )
        if "returns" in want:
            pops = [e for e in trace.of("frame_pop") if e.get("frame") == push.get("frame")]
            returned = (
                _decode(pops[0]["return_value"], trace)
                if pops and "return_value" in pops[0]
                else _MISSING
            )
            result.check(
                returned == want["returns"],
                f"{want['func']} returned: expected {want['returns']!r}, got {returned!r}",
            )


def _check_recursion(expect: dict[str, Any], trace: Trace, result: Result) -> None:
    want = expect.get("recursion")
    if not want:
        return
    pushes = [e for e in trace.of("frame_push") if e.get("func") == want["func"]]
    depths = [e.get("recursion_depth") for e in pushes]
    result.check(
        depths == want["depths"], f"recursion depths: expected {want['depths']}, got {depths}"
    )
    ids = {e.get("frame") for e in pushes}
    result.check(
        len(ids) == len(pushes), "each recursive call must get its own frame id, never a reused one"
    )
    if "outer_returns" in want and pushes:
        outer = pushes[0]["frame"]
        pops = [e for e in trace.of("frame_pop") if e.get("frame") == outer]
        returned = (
            _decode(pops[0]["return_value"], trace)
            if pops and "return_value" in pops[0]
            else _MISSING
        )
        result.check(
            returned == want["outer_returns"],
            f"outermost call returned: expected {want['outer_returns']!r}, got {returned!r}",
        )


def _check_exceptions(expect: dict[str, Any], trace: Trace, result: Result) -> None:
    want = expect.get("exceptions")
    if not want:
        return
    if "raised" in want:
        raised = len(trace.of("exception_raise"))
        result.check(
            raised == want["raised"],
            f"exceptions raised: expected {want['raised']}, got {raised} "
            "(one exception crossing several frames is still one exception)",
        )
    if "caught" in want:
        caught = len(trace.of("exception_catch"))
        result.check(caught == want["caught"], f"exceptions caught: expected {want['caught']}, got {caught}")
    if "uncaught" in want:
        uncaught = trace.of("exception_uncaught")
        result.check(bool(uncaught), "expected an uncaught exception to be reported")
        if uncaught:
            result.check(
                uncaught[0]["type"] == want["uncaught"],
                f"uncaught type: expected {want['uncaught']}, got {uncaught[0]['type']}",
            )
            stack = uncaught[0].get("stack") or []
            result.check(bool(stack), "an uncaught exception must report where it happened")
            result.check(
                all("tracer" not in entry.get("func", "") for entry in stack),
                "the traceback must contain only the user's own frames",
            )

    if expect.get("no_exception_reported"):
        result.check(
            not trace.of("exception_raise") and not trace.of("exception_uncaught"),
            "a run stopped by a budget must not look like a program that raised",
        )


def _check_heap(expect: dict[str, Any], trace: Trace, result: Result) -> None:
    if "min_objects" in expect:
        count = len(trace.of("obj_new"))
        result.check(
            count >= expect["min_objects"],
            f"objects: expected at least {expect['min_objects']}, got {count}",
        )

    for group in expect.get("aliases") or []:
        values = [trace.final_value(name) for name in group]
        result.check(
            all(isinstance(value, _Ref) for value in values),
            f"aliases {group} should all be references, got {values!r}",
        )
        result.check(
            len({value.obj for value in values if isinstance(value, _Ref)}) == 1,
            f"aliases {group} must point at the same object, got {values!r}",
        )

    if "mutation_count" in expect:
        # Appends and element writes, not the initial fill: one mutation through an alias is one
        # event, not one per name pointing at the object.
        mutations = [
            e for e in trace.of("obj_set") if e.get("op") in ("append", "insert", "delete")
        ]
        result.check(
            len(mutations) == expect["mutation_count"],
            f"mutations: expected {expect['mutation_count']}, got {len(mutations)}",
        )

    if expect.get("has_self_type_reference"):
        by_id = {e["obj"]: e for e in trace.of("obj_new")}
        found = False
        for event in trace.of("obj_set"):
            value = event.get("value", {})
            if "ref" not in value:
                continue
            owner = by_id.get(event["obj"])
            target = by_id.get(value["ref"])
            if owner and target and owner["type_name"] == target["type_name"]:
                found = True
                break
        result.check(found, "expected an object referring to another of its own type")


def _check_stdin(expect: dict[str, Any], trace: Trace, result: Result) -> None:
    wanted = expect.get("stdin_exchanges")
    if wanted is None:
        return
    requests = trace.of("stdin_request")
    responses = trace.of("stdin_response")
    result.check(
        len(requests) == len(wanted), f"input requests: expected {len(wanted)}, got {len(requests)}"
    )
    result.check(
        len(responses) == len(wanted),
        f"input answers: expected {len(wanted)}, got {len(responses)} "
        "(an answer must be recorded so a replay needs no human)",
    )
    for index, want in enumerate(wanted):
        if index < len(requests) and "prompt" in want:
            got = requests[index].get("prompt")
            result.check(
                got == want["prompt"],
                f"prompt {index}: expected {want['prompt']!r}, got {got!r}",
            )
        if index < len(responses) and "answer" in want:
            got = responses[index].get("text")
            result.check(
                got == want["answer"], f"answer {index}: expected {want['answer']!r}, got {got!r}"
            )


def _check_library(expect: dict[str, Any], trace: Trace, result: Result) -> None:
    if expect.get("has_library_frame"):
        library = [e for e in trace.of("frame_push") if e.get("kind") == "library"]
        result.check(bool(library), "expected a library call to appear as an opaque frame")

    if expect.get("no_steps_inside_library"):
        library_frames = {
            e["frame"] for e in trace.of("frame_push") if e.get("kind") == "library"
        }
        inside = [e for e in trace.of("step_line") if e.get("frame") in library_frames]
        result.check(
            not inside,
            f"{len(inside)} line steps were recorded inside library code, which should be opaque",
        )


def _check_structure(expect: dict[str, Any], trace: Trace, result: Result) -> None:
    if expect.get("frames_balanced"):
        pushes = len(trace.of("frame_push"))
        pops = len(trace.of("frame_pop"))
        result.check(pushes == pops, f"{pushes} frames pushed but {pops} popped")

    if expect.get("has_warning_note"):
        result.check(
            any(note.get("level") == "warn" for note in trace.of("note")),
            "expected a warning explaining why the run stopped",
        )


# ---------------------------------------------------------------------------
# adapters
# ---------------------------------------------------------------------------


def run_python(case: Case) -> Trace:
    """Trace a case with the Python adapter, in process."""
    from flow_view_tracer.emit import Limits
    from flow_view_tracer.collapse import (
        DEFAULT_CHUNK,
        DEFAULT_KEEP_HEAD,
        DEFAULT_KEEP_TAIL,
        DEFAULT_MIN_ITERATIONS,
    )
    from flow_view_tracer.tracer import TracerOptions, run_source

    DEFAULT_COLLAPSE = {
        "keep_head": DEFAULT_KEEP_HEAD,
        "keep_tail": DEFAULT_KEEP_TAIL,
        "chunk": DEFAULT_CHUNK,
        "min_iterations": DEFAULT_MIN_ITERATIONS,
    }

    source = case.source_for("python")
    assert source is not None

    limits_in = case.expect.get("limits") or {}
    limits = Limits(
        max_steps=int(limits_in.get("max_steps", 200_000)),
        wall_ms=int(limits_in.get("wall_ms", 30_000)),
    )

    events: list[dict[str, Any]] = []
    header: dict[str, Any] = {}

    def sink(event: dict[str, Any]) -> None:
        if "session" in event:
            header.update(event)
        else:
            events.append(event)

    stdin_text = case.expect.get("stdin")
    previous_stdin = sys.stdin
    if stdin_text:
        import io

        sys.stdin = io.StringIO(stdin_text)
    try:
        # Traced the way the product traces, collapsing included. A corpus that pinned behaviour the
        # user never gets would pin the wrong thing. Cases below the fold threshold are unaffected,
        # which is why enabling it here changed none of the existing fifteen.
        status = run_source(
            source,
            "main.py",
            on_event=sink,
            limits=limits,
            options=TracerOptions(collapse=DEFAULT_COLLAPSE),
        )
    finally:
        sys.stdin = previous_stdin

    return Trace(
        schema=header.get("schema", ""),
        session=header.get("session", {}),
        events=events,
        status=status,
    )


#: Adapters that exist. A language is added here once its adapter is built, and the same corpus then
#: governs it with no new expectations to write.
ADAPTERS: dict[str, Callable[[Case], Trace]] = {"python": run_python}


def write_trace(case: Case, language: str, trace: Trace) -> Path:
    """Save a trace for the TypeScript replay suite to check.

    Invertibility lives with the TraceStore, which is the single implementation of trace semantics.
    Writing traces out lets that suite exercise real adapter output instead of hand-written fixtures.
    """
    TRACE_OUT.mkdir(parents=True, exist_ok=True)
    path = TRACE_OUT / f"{case.directory.name}.{language}.json"
    path.write_text(json.dumps(trace.document, separators=(",", ":")), encoding="utf-8")
    return path


def run_all(*, write: bool = True) -> list[Result]:
    results: list[Result] = []
    for case in load_cases():
        for language, adapter in ADAPTERS.items():
            if case.source_for(language) is None:
                continue
            trace = adapter(case)
            if write:
                write_trace(case, language, trace)
            results.append(verify(case, trace))
    return results


def main() -> int:
    results = run_all()
    failed = [result for result in results if not result.passed]
    for result in results:
        print(result.describe())
    print()
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    if failed:
        return 1
    print(f"traces written to {TRACE_OUT.relative_to(REPO)} for the replay suite")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
