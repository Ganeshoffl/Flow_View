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


#: Expectations a case is allowed to restate for one language, and nothing else.
#:
#: Every entry here is a piece of a *language's surface* rather than a fact about execution: the exact text
#: its print statement produces, the name its runtime happens to give an error. Python prints ``None`` where
#: JavaScript prints ``null``, and Python's ``IndexError`` has no JavaScript counterpart. Pretending
#: otherwise would mean writing programs that contort themselves to produce identical text, which tests the
#: contortion rather than the adapter.
#:
#: What is deliberately *not* here: counts, final values, control flow, call results, heap structure. An
#: adapter that needed one of those restated would be reporting different behaviour, and noticing that is
#: the entire reason this corpus exists. The runner refuses such an override rather than honouring it, so
#: the fence cannot be quietly stepped over later.
SURFACE_KEYS = frozenset({"stdout", "stderr"})

#: Keys whose *sub-fields* may be restated, listing exactly which ones.
SURFACE_SUBKEYS: dict[str, frozenset[str]] = {"exceptions": frozenset({"uncaught"})}


@dataclass
class Case:
    """One program plus what every adapter must report about it."""

    name: str
    directory: Path
    description: str
    concepts: list[str]
    expect: dict[str, Any]
    per_language: dict[str, dict[str, Any]] = field(default_factory=dict)
    not_applicable: dict[str, str] = field(default_factory=dict)

    def expect_for(self, language: str) -> dict[str, Any]:
        """The shared expectations, with this language's surface restated over them."""
        override = self.per_language.get(language)
        if not override:
            return self.expect

        merged = dict(self.expect)
        for key, value in override.items():
            if key in SURFACE_KEYS:
                merged[key] = value
            elif key in SURFACE_SUBKEYS:
                refused = sorted(set(value) - SURFACE_SUBKEYS[key])
                if refused:
                    raise ValueError(
                        f"{self.name}: {language} may not restate {key}.{refused} - only "
                        f"{sorted(SURFACE_SUBKEYS[key])} is language surface. The rest describes what "
                        f"happened, and every adapter owes the same answer."
                    )
                merged[key] = {**(self.expect.get(key) or {}), **value}
            else:
                raise ValueError(
                    f"{self.name}: {language} may not restate {key!r}. Only "
                    f"{sorted(SURFACE_KEYS)} and {sorted(SURFACE_SUBKEYS)} sub-keys are language "
                    f"surface; everything else is behaviour every adapter must agree on."
                )
        return merged

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
                per_language=meta.get("expect_per_language", {}),
                not_applicable=meta.get("not_applicable", {}),
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
    language = trace.session.get("language", "?")
    result = Result(case.name, language)
    expect = case.expect_for(language)

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

    if expect.get("has_self_type_reference") or "self_type_reference_count" in expect:
        by_id = {e["obj"]: e for e in trace.of("obj_new")}
        links = set()
        for event in trace.of("obj_set"):
            value = event.get("value", {})
            if "ref" not in value:
                continue
            owner = by_id.get(event["obj"])
            target = by_id.get(value["ref"])
            if owner and target and owner["type_name"] == target["type_name"]:
                links.add((event["obj"], event["key"], value["ref"]))

        if expect.get("has_self_type_reference"):
            result.check(links, "expected an object referring to another of its own type")

        # Counting the links, not merely finding one, is what makes a chain testable. An adapter whose heap
        # walk stops following a reference once it has seen it still reports the *first* link and looks
        # correct; what it loses is every link after that, which is the whole structure.
        if "self_type_reference_count" in expect:
            result.check(
                len(links) == expect["self_type_reference_count"],
                f"links between objects of one type: "
                f"expected {expect['self_type_reference_count']}, got {len(links)}",
            )


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
def run_javascript(case: Case) -> Trace:
    """Trace a program with the JavaScript adapter, by running its CLI.

    A subprocess rather than an in-process call, because that is how the server runs it too. Testing it
    any other way would leave the path the product actually takes unexercised.
    """
    import shutil
    import subprocess
    import tempfile

    source = case.source_for("javascript")
    assert source is not None

    node = shutil.which("node")
    if node is None:
        raise RuntimeError("node is not on PATH, so the JavaScript adapter cannot run")

    # The limits the case asks for, not whatever the adapter defaults to. A case that declares a budget of
    # 400 steps is testing what happens at 400 steps; running it at the default 200,000 still ends in
    # `step_limit` and still looks like a pass, while having tested something the case never asked about.
    limits_in = case.expect.get("limits") or {}
    max_steps = int(limits_in.get("max_steps", 200_000))
    wall_ms = int(limits_in.get("wall_ms", 30_000))

    cli = REPO / "adapters" / "javascript" / "src" / "cli.js"
    with tempfile.TemporaryDirectory(prefix="flow_view_js_") as workdir:
        program = Path(workdir) / "main.js"
        program.write_text(source, encoding="utf-8")
        completed = subprocess.run(
            [
                node,
                str(cli),
                "--source",
                str(program),
                "--max-steps",
                str(max_steps),
                "--wall-ms",
                str(wall_ms),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            input=case.expect.get("stdin") or "",
        )

    header: dict[str, Any] = {}
    events: list[dict[str, Any]] = []
    for line in completed.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "session" in parsed:
            header = parsed
        else:
            events.append(parsed)

    if not header:
        raise RuntimeError(
            f"the JavaScript adapter produced no header.\nstderr:\n{completed.stderr[-2000:]}"
        )

    # The adapter reports how the run ended in `run_end`, which is the same place the Python adapter's
    # status comes from - it just happens to return it directly there.
    ended = [e for e in events if e.get("t") == "run_end"]
    status = ended[-1].get("status", "error") if ended else "error"

    return Trace(
        schema=header.get("schema", ""),
        session=header.get("session", {}),
        events=events,
        status=status,
    )


ADAPTERS: dict[str, Callable[[Case], Trace]] = {"python": run_python, "javascript": run_javascript}


def write_trace(case: Case, language: str, trace: Trace) -> Path:
    """Save a trace for the TypeScript replay suite to check.

    Invertibility lives with the TraceStore, which is the single implementation of trace semantics.
    Writing traces out lets that suite exercise real adapter output instead of hand-written fixtures.
    """
    TRACE_OUT.mkdir(parents=True, exist_ok=True)
    path = TRACE_OUT / f"{case.directory.name}.{language}.json"
    path.write_text(json.dumps(trace.document, separators=(",", ":")), encoding="utf-8")
    return path


def clear_traces() -> None:
    """Remove previously recorded traces before writing the current ones.

    Stale traces are worse than missing ones. The directory is not version controlled, so switching
    branches leaves behind files for cases that no longer exist — and the replay suite reads the
    *directory*, so it will happily replay a trace produced by code that is no longer checked out. It
    did: a case added on another branch went on being replayed here, and the suite reported fifteen
    extra passing tests for a corpus entry this commit does not contain.
    """
    if not TRACE_OUT.exists():
        return
    for stale in TRACE_OUT.glob("*.json"):
        stale.unlink()


def write_manifest(written: list[str]) -> None:
    """Record exactly which traces belong to this run, so the replay suite can insist on the set.

    Clearing the directory stops stale files accumulating, but it cannot help a suite that runs
    without the generator having run at all, or after only some cases were written. The manifest lets
    the replay suite check the set it found is the set that was meant.
    """
    TRACE_OUT.mkdir(parents=True, exist_ok=True)
    (TRACE_OUT / "manifest.json").write_text(
        json.dumps({"traces": sorted(written)}, indent=2) + "\n", encoding="utf-8"
    )


def coverage_report(cases: list[Case]) -> list[str]:
    """What each adapter does *not* cover, and whether it has said why.

    A case with no source file for a language simply does not run, and nothing in the pass count reflects
    that. Nine of sixteen cases passing reads exactly like sixteen of sixteen if the other seven were never
    attempted, so the absences are printed next to the results. A gap with a stated reason is a decision; a
    gap without one is work not done yet, and the difference should not have to be reconstructed by
    comparing directory listings.
    """
    lines: list[str] = []
    for language in ADAPTERS:
        absent = [case for case in cases if case.source_for(language) is None]
        if not absent:
            lines.append(f"{language}: covers all {len(cases)} cases")
            continue

        explained = [case for case in absent if language in case.not_applicable]
        unexplained = [case for case in absent if language not in case.not_applicable]
        lines.append(
            f"{language}: covers {len(cases) - len(absent)}/{len(cases)} cases"
            f" ({len(explained)} not applicable, {len(unexplained)} not yet written)"
        )
        for case in explained:
            reason = case.not_applicable[language]
            lines.append(f"    - {case.name}: not applicable. {reason}")
        for case in unexplained:
            lines.append(f"    - {case.name}: no {SOURCE_FILES[language]} yet, and no reason recorded")
    return lines


def run_all(*, write: bool = True) -> list[Result]:
    results: list[Result] = []
    written: list[str] = []
    if write:
        clear_traces()
    for case in load_cases():
        for language, adapter in ADAPTERS.items():
            if case.source_for(language) is None:
                continue
            trace = adapter(case)
            if write:
                written.append(write_trace(case, language, trace).stem)
            results.append(verify(case, trace))
    if write:
        write_manifest(written)
    return results


def main() -> int:
    results = run_all()
    failed = [result for result in results if not result.passed]
    for result in results:
        print(result.describe())
    print()
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    print()
    print("coverage")
    for line in coverage_report(load_cases()):
        print(f"  {line}")
    print()
    if failed:
        return 1
    print(f"traces written to {TRACE_OUT.relative_to(REPO)} for the replay suite")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
