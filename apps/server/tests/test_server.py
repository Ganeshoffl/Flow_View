"""Tests for the server.

The server's job is narrow — run a program, carry stdin, report what this machine can do — so these
tests are about the seams: that a trace arrives intact over a socket, that a stopped run cannot
outlive its session, and that capabilities tell the truth about missing toolchains rather than
claiming support and failing later.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "server"))
sys.path.insert(0, str(ROOT / "packages" / "trace-schema" / "python"))

from fastapi.testclient import TestClient  # noqa: E402

from flow_view_schema import check_trace_invariants, validate_trace  # noqa: E402
from flow_view_server.app import create_app  # noqa: E402


@pytest.fixture
def client() -> Any:
    with TestClient(create_app()) as test_client:
        yield test_client


def collect(socket: Any, *, timeout_messages: int = 4000) -> dict[str, Any]:
    """Drain a session socket until the run completes."""
    header: dict[str, Any] = {}
    events: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for _ in range(timeout_messages):
        message = socket.receive_json()
        kind = message.get("type")
        if kind == "session":
            header = message
        elif kind == "events":
            events.extend(message["events"])
        elif kind == "error":
            errors.append(message)
            break
        elif kind == "complete":
            break

    return {"header": header, "events": events, "errors": errors}


def run_program(client: Any, source: str, language: str = "python", **extra: Any) -> dict[str, Any]:
    session = client.post("/api/session").json()
    with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
        socket.send_json({"type": "run", "language": language, "source": source, **extra})
        return collect(socket)


def node_is_absent() -> bool:
    """Whether this machine can run the JavaScript adapter at all.

    Used to skip rather than fail, because a machine without Node is a machine where JavaScript being
    unavailable is the correct behaviour — and there is a test for that case too.
    """
    import shutil

    return shutil.which("node") is None


needs_node = pytest.mark.skipif(node_is_absent(), reason="Node is not installed on this machine")


def jdk_is_absent() -> bool:
    """Whether this machine has a JDK. A JRE is not enough: tracing needs javac and jdk.jdi."""
    import shutil

    return shutil.which("java") is None or shutil.which("javac") is None

needs_jdk = pytest.mark.skipif(jdk_is_absent(), reason="No JDK on this machine")


class TestCapabilities:
    def test_python_is_available(self, client: Any) -> None:
        payload = client.get("/api/capabilities").json()
        python = next(item for item in payload["languages"] if item["language"] == "python")
        assert python["available"] is True
        assert python["version"]

    def test_unbuilt_languages_say_so_and_name_the_phase(self, client: Any) -> None:
        # A language that is merely not built yet must not look like a broken installation.
        payload = client.get("/api/capabilities").json()
        for language in ("c", "cpp"):
            item = next(i for i in payload["languages"] if i["language"] == language)
            assert item["available"] is False
            assert item["reason"]
            assert item["planned"]

    @needs_jdk
    def test_java_is_available(self, client: Any) -> None:
        payload = client.get("/api/capabilities").json()
        java = next(item for item in payload["languages"] if item["language"] == "java")
        assert java["available"] is True
        assert java["version"]
        assert not java["reason"]
        assert not java["planned"]

    @needs_node
    def test_javascript_is_available(self, client: Any) -> None:
        payload = client.get("/api/capabilities").json()
        js = next(item for item in payload["languages"] if item["language"] == "javascript")
        assert js["available"] is True
        assert js["version"], "an available language must report the version that will run the code"
        # Nothing left to promise or to apologise for.
        assert not js["reason"]
        assert not js["planned"]

    def test_javascript_without_node_blames_node_rather_than_the_adapter(
        self, client: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The two reasons JavaScript might not work are different, and so are their remedies.

        The first version reported "the adapter is not built yet" even on a machine with no Node at all,
        which is advice that cannot be acted on: there is nothing to wait for, something to install.
        """
        import shutil as shutil_module

        # Fetched from sys.modules rather than imported by name. `flow_view_server/__init__.py` does
        # `from .capabilities import capabilities`, which rebinds the attribute `flow_view_server
        # .capabilities` from the submodule to the function — so every spelling of the import, including
        # `import flow_view_server.capabilities as x`, hands back the function instead of the module.
        import importlib

        capabilities_module = importlib.import_module("flow_view_server.capabilities")

        real_which = shutil_module.which
        monkeypatch.setattr(
            capabilities_module.shutil,
            "which",
            lambda name, *args, **kwargs: None if name == "node" else real_which(name, *args, **kwargs),
        )
        capabilities_module.language_support.cache_clear()
        try:
            entry = next(
                item
                for item in capabilities_module.language_support()
                if item.language == "javascript"
            )
            assert entry.available is False
            assert "Node" in (entry.reason or "")
            assert entry.remedy, "a missing tool must come with the way to get it"
            assert "Install Node" in entry.remedy
        finally:
            # The probe is cached for the life of the process, so a lie left here would follow every
            # later test.
            capabilities_module.language_support.cache_clear()

    def test_a_missing_toolchain_offers_a_remedy(self, client: Any) -> None:
        import shutil

        payload = client.get("/api/capabilities").json()
        if shutil.which("gdb") is None:
            c = next(i for i in payload["languages"] if i["language"] == "c")
            assert "gdb" in (c["reason"] or "")
            assert c["remedy"], "a missing tool must come with the command that installs it"

    def test_inactive_guards_are_listed_rather_than_implied(self, client: Any) -> None:
        payload = client.get("/api/capabilities").json()
        assert "guards" in payload
        assert isinstance(payload["inactive_guards"], list)
        for name in payload["inactive_guards"]:
            assert payload["guards"][name] is False


class TestSessions:
    def test_a_session_can_be_created_and_closed(self, client: Any) -> None:
        session = client.post("/api/session").json()
        assert session["id"]
        assert client.delete(f"/api/session/{session['id']}").json()["closed"] is True

    def test_connecting_to_an_unknown_session_is_explained(self, client: Any) -> None:
        with client.websocket_connect("/api/session/does-not-exist/ws") as socket:
            message = socket.receive_json()
        assert message["type"] == "error"
        assert "no longer exists" in message["message"]

    def test_an_unknown_message_type_is_reported(self, client: Any) -> None:
        session = client.post("/api/session").json()
        with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
            socket.send_json({"type": "nonsense"})
            message = socket.receive_json()
        assert message["type"] == "error"

    def test_ping_is_answered(self, client: Any) -> None:
        session = client.post("/api/session").json()
        with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
            socket.send_json({"type": "ping"})
            assert socket.receive_json()["type"] == "pong"


class TestRunning:
    def test_a_trace_survives_the_round_trip_intact(self, client: Any) -> None:
        result = run_program(client, "x = 1\ny = x + 2\nprint(y)\n")
        assert not result["errors"]
        document = {
            "schema": result["header"]["schema"],
            "session": result["header"]["session"],
            "events": result["events"],
        }
        shape = validate_trace(document)
        assert shape.valid, shape.describe()
        coherence = check_trace_invariants(document)
        assert coherence.valid, coherence.describe()

    def test_the_header_arrives_before_any_event(self, client: Any) -> None:
        session = client.post("/api/session").json()
        with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
            socket.send_json({"type": "run", "language": "python", "source": "x = 1\n"})
            first = socket.receive_json()
        assert first["type"] == "session", "the UI needs the header before it can place anything"
        assert first["session"]["language"] == "python"

    def test_program_output_is_relayed(self, client: Any) -> None:
        result = run_program(client, "for i in range(3):\n    print(i)\n")
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert printed == "0\n1\n2\n"

    def test_the_header_reports_which_guards_are_in_force(self, client: Any) -> None:
        result = run_program(client, "x = 1\n")
        guards = result["header"]["session"].get("guards_active")
        assert guards, "a run must state what was protecting it"

    def test_an_infinite_loop_is_stopped_and_still_yields_a_usable_trace(self, client: Any) -> None:
        result = run_program(
            client,
            "n = 0\nwhile True:\n    n += 1\n",
            limits={"max_steps": 400},
        )
        end = [e for e in result["events"] if e["t"] == "run_end"]
        assert end and end[0]["status"] == "step_limit"
        document = {
            "schema": result["header"]["schema"],
            "session": result["header"]["session"],
            "events": result["events"],
        }
        assert check_trace_invariants(document).valid

    def test_a_failing_program_is_a_result_not_an_error(self, client: Any) -> None:
        result = run_program(client, "v = [1]\nprint(v[9])\n")
        assert not result["errors"], "a program that raises is not a server error"
        end = [e for e in result["events"] if e["t"] == "run_end"]
        assert end[0]["status"] == "error"
        assert [e for e in result["events"] if e["t"] == "exception_uncaught"]

    def test_a_syntax_error_is_reported_on_the_offending_program(self, client: Any) -> None:
        result = run_program(client, "def broken(\n")
        notes = [e["text"] for e in result["events"] if e["t"] == "note"]
        assert any("parse" in note.lower() for note in notes)

    def test_prefilled_stdin_produces_a_run_with_no_human_involved(self, client: Any) -> None:
        result = run_program(
            client,
            "name = input()\nage = int(input())\nprint(name, age)\n",
            stdin="Ada\n36\n",
        )
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert "Ada 36" in printed
        responses = [e for e in result["events"] if e["t"] == "stdin_response"]
        assert len(responses) == 2, "the answers must be recorded so a replay needs no human"

    def test_an_unbuilt_language_is_refused_clearly(self, client: Any) -> None:
        result = run_program(client, "int main(){}", language="c")
        assert result["errors"]
        message = result["errors"][0]["message"]
        assert "not available yet" in message
        # And it says what *is* available, so the answer to "then what can I use" is in the same sentence.
        assert "python" in message

    def test_a_language_nobody_has_heard_of_is_refused_rather_than_attempted(
        self, client: Any
    ) -> None:
        result = run_program(client, "puts 1", language="ruby")
        assert result["errors"]
        assert "not available yet" in result["errors"][0]["message"]


@needs_jdk
class TestRunningJava:
    """The third adapter through the same seams, and a JVM behaves less like the others than Node does.

    Two of these exist because of defects found only by running Java here rather than from a shell: the `java`
    on PATH is usually a version manager's shim that cannot work in a scrubbed environment, and neither the
    tracer's JVM nor the program's can start inside the address-space ceiling applied to every other child.
    """

    JAVA_PROGRAM = (
        "public class Main {\n"
        "    static int twice(int n) {\n"
        "        return n * 2;\n"
        "    }\n"
        "\n"
        "    public static void main(String[] args) {\n"
        "        int total = 0;\n"
        "        for (int i = 0; i < 3; i++) {\n"
        "            total += twice(i);\n"
        "        }\n"
        "        System.out.println(total);\n"
        "    }\n"
        "}\n"
    )

    def test_a_trace_survives_the_round_trip_intact(self, client: Any) -> None:
        result = run_program(client, self.JAVA_PROGRAM, language="java")
        assert not result["errors"], result["errors"]
        document = {
            "schema": result["header"]["schema"],
            "session": result["header"]["session"],
            "events": result["events"],
        }
        shape = validate_trace(document)
        assert shape.valid, shape.describe()
        coherence = check_trace_invariants(document)
        assert coherence.valid, coherence.describe()

    def test_the_header_says_which_language_ran(self, client: Any) -> None:
        session = client.post("/api/session").json()
        with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
            socket.send_json(
                {"type": "run", "language": "java", "source": self.JAVA_PROGRAM}
            )
            first = socket.receive_json()
            # Drained to the end rather than walked away from.
            #
            # Leaving after the first message abandons a live JVM. The server does stop it, but the process
            # transport is then released while this test is already over, and its finalizer runs against a closed
            # event loop — surfacing as an unraisable-exception warning blamed on whichever test happened to be
            # running when the collector woke up. Two JVMs take long enough to die that Java makes this visible.
            while True:
                message = socket.receive_json()
                if message.get("type") in ("complete", "error"):
                    break
        assert first["type"] == "session"
        assert first["session"]["language"] == "java"

    def test_the_tracer_starts_despite_a_version_manager_shim(self, client: Any) -> None:
        """The JVM has to actually run, in a child with almost no environment.

        `java` on PATH is typically a shim that resolves the version from its own configuration, using `HOME` —
        which this server points at the run directory. Started that way the shim fails with "java is not a valid
        shim" and the run dies before the JVM exists. Any output at all proves the real binary was found.
        """
        result = run_program(client, self.JAVA_PROGRAM, language="java")
        assert not result["errors"], result["errors"]
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert printed == "6\n"

    def test_a_program_that_calls_a_method_reports_the_call(self, client: Any) -> None:
        result = run_program(client, self.JAVA_PROGRAM, language="java")
        calls = [e for e in result["events"] if e["t"] == "frame_push" and e["func"] == "twice"]
        assert len(calls) == 3
        returns = [
            e["return_value"]["prim"]
            for e in result["events"]
            if e["t"] == "frame_pop" and "return_value" in e
        ]
        assert returns == [0, 2, 4]

    def test_an_assignment_is_blamed_on_the_line_that_made_it(self, client: Any) -> None:
        """Including the first statement of a method, which is the one that gets this wrong.

        A variable is only seen to have changed after the statement that changed it, so the change is attributed
        to the line that just finished. At the start of a method there is no previous line to fall back on, and
        without seeding the frame from its entry location every method's opening assignment is reported one line
        late — pointing the code pane at the statement after the one responsible.
        """
        result = run_program(
            client,
            "public class Main {\n"          # 1
            "    public static void main(String[] args) {\n"   # 2
            "        int first = 10;\n"      # 3
            "        int second = 20;\n"     # 4
            "        int third = first + second;\n"  # 5
            "        System.out.println(third);\n"   # 6
            "    }\n"
            "}\n",
            language="java",
        )
        assigned = {
            e["name"]: e["line"]
            for e in result["events"]
            if e["t"] == "var_set" and e["name"] in ("first", "second", "third")
        }
        assert assigned == {"first": 3, "second": 4, "third": 5}, assigned

    def test_frames_are_right_after_an_exception_unwinds(self, client: Any) -> None:
        """The JVM reports no method exit for a method that exits by throwing.

        So the frame stack has to be re-checked against the JVM's rather than trusted. Without that, the frame
        the exception left stays on the stack forever and everything afterwards — the catch, the output, the
        return — is attributed to a method that is no longer running.
        """
        result = run_program(
            client,
            "public class Main {\n"
            "    static int divide(int a, int b) {\n"
            "        return a / b;\n"
            "    }\n"
            "\n"
            "    public static void main(String[] args) {\n"
            "        int result;\n"
            "        try {\n"
            "            result = divide(1, 0);\n"
            "        } catch (ArithmeticException error) {\n"
            "            result = -1;\n"
            "        }\n"
            "        System.out.println(result);\n"
            "    }\n"
            "}\n",
            language="java",
        )
        assert not result["errors"], result["errors"]
        events = result["events"]

        main_frame = next(e["frame"] for e in events if e["t"] == "frame_push" and e["func"] == "main")
        divide_frame = next(
            e["frame"] for e in events if e["t"] == "frame_push" and e["func"] == "divide"
        )
        assert main_frame != divide_frame

        # The frame that was thrown out of is popped, and said to have been popped for that reason.
        thrown_out = [
            e for e in events if e["t"] == "frame_pop" and e["frame"] == divide_frame
        ]
        assert thrown_out, "the frame the exception left was never closed"
        assert thrown_out[0]["reason"] == "exception"

        # And the handler belongs to the method that has the handler.
        caught = [e for e in events if e["t"] == "exception_catch"]
        assert caught and caught[0]["frame"] == main_frame

        printed = [e for e in events if e["t"] == "stdout"]
        assert printed and printed[0]["frame"] == main_frame
        assert printed[0]["text"] == "-1\n"

    def test_a_loop_reports_its_iterations(self, client: Any) -> None:
        result = run_program(client, self.JAVA_PROGRAM, language="java")
        exits = [e for e in result["events"] if e["t"] == "loop_exit"]
        assert exits and exits[0]["iterations"] == 3
        assert exits[0]["reason"] == "condition"

    def test_a_failing_program_is_a_result_not_an_error(self, client: Any) -> None:
        result = run_program(
            client,
            "public class Main {\n"
            "    public static void main(String[] args) {\n"
            "        int[] values = {1, 2, 3};\n"
            "        System.out.println(values[7]);\n"
            "    }\n"
            "}\n",
            language="java",
        )
        assert not result["errors"], "a program that throws is not a server error"
        end = [e for e in result["events"] if e["t"] == "run_end"]
        assert end[0]["status"] == "error"
        uncaught = [e for e in result["events"] if e["t"] == "exception_uncaught"]
        assert uncaught and uncaught[0]["type"] == "ArrayIndexOutOfBoundsException"
        assert uncaught[0]["stack"]

    def test_a_program_that_does_not_compile_says_so_on_its_own_line(self, client: Any) -> None:
        result = run_program(
            client,
            "public class Main {\n    public static void main(String[] args) {\n        int x = ;\n    }\n}\n",
            language="java",
        )
        notes = [e["text"] for e in result["events"] if e["t"] == "note"]
        assert any("compile" in note.lower() for note in notes), notes
        end = [e for e in result["events"] if e["t"] == "run_end"]
        assert end and end[0]["status"] == "error"

    def test_an_endless_loop_is_stopped_rather_than_left_running(self, client: Any) -> None:
        """A loop written on one line never changes line, so the JVM reports no further steps at all.

        The tracer waited for an event that would never arrive and hung for as long as it was allowed to. The
        clock is the only thing that can end this run, so the run has to be able to notice the clock while no
        events are coming.
        """
        result = run_program(
            client,
            "public class Main {\n"
            "    public static void main(String[] args) {\n"
            "        int n = 0;\n"
            "        while (true) { n += 1; }\n"
            "    }\n"
            "}\n",
            language="java",
            limits={"wall_ms": 4000},
        )
        end = [e for e in result["events"] if e["t"] == "run_end"]
        assert end and end[0]["status"] in ("timeout", "step_limit")
        document = {
            "schema": result["header"]["schema"],
            "session": result["header"]["session"],
            "events": result["events"],
        }
        # A truncated run still has to close every frame it opened.
        assert check_trace_invariants(document).valid

    def test_an_object_changing_under_an_unchanged_name_is_still_seen(self, client: Any) -> None:
        """The name `head` never changes; the structure it points at does.

        Reading state only when the source says it could have changed is what makes this adapter usably fast, and
        the risk of that is skipping something real. A list grown through an alias, and a chain extended two
        levels down, are the two shapes that catch it.
        """
        result = run_program(
            client,
            "import java.util.ArrayList;\n"
            "import java.util.List;\n"
            "\n"
            "public class Main {\n"
            "    static class Node { int value; Node next; Node(int v) { value = v; next = null; } }\n"
            "\n"
            "    public static void main(String[] args) {\n"
            "        List<Integer> items = new ArrayList<>(List.of(1, 2, 3));\n"
            "        List<Integer> alias = items;\n"
            "        alias.add(4);\n"
            "        Node head = new Node(1);\n"
            "        head.next = new Node(2);\n"
            "        head.next.next = new Node(3);\n"
            "        System.out.println(items.size() + \" \" + head.next.next.value);\n"
            "    }\n"
            "}\n",
            language="java",
        )
        assert not result["errors"], result["errors"]
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert printed == "4 3\n"

        writes = [e for e in result["events"] if e["t"] == "obj_set"]
        # The append through the alias is a mutation, not part of building the list.
        assert [w for w in writes if w.get("op") == "append"], "growing a list through an alias was not seen"

        # And the link two levels down, where the reference above it never changed.
        announced = {e["obj"]: e["type_name"] for e in result["events"] if e["t"] == "obj_new"}
        nodes = [obj for obj, name in announced.items() if name == "Node"]
        assert len(nodes) == 3, f"expected three Nodes, got {announced}"
        links = {
            (w["obj"], w["value"]["ref"])
            for w in writes
            if w.get("key") == "next" and "ref" in w.get("value", {})
        }
        assert len(links) == 2, f"expected two links between Nodes, got {links}"

    def test_a_long_loop_arrives_folded_and_still_reports_the_right_answer(
        self, client: Any
    ) -> None:
        """Folding, through the server, with the Java collapser rather than the Python or JavaScript one.

        Folding does not make Java faster — the JVM is stepped through every iteration either way. What it buys
        is a trace short enough to hold and scrub, with the final state still exact.
        """
        result = run_program(
            client,
            "public class Main {\n"
            "    public static void main(String[] args) {\n"
            "        int total = 0;\n"
            "        for (int i = 0; i < 500; i++) {\n"
            "            total += i;\n"
            "        }\n"
            "        System.out.println(total);\n"
            "    }\n"
            "}\n",
            language="java",
            limits={"wall_ms": 120_000},
        )
        assert not result["errors"], result["errors"]
        folds = [e for e in result["events"] if e["t"] == "collapse"]
        assert folds, "a five-hundred iteration loop must not arrive one step at a time"

        folded = sum(f["iterations"] for f in folds)
        verbatim = len([e for e in result["events"] if e["t"] == "loop_iter"])
        assert folded + verbatim == 500, "every iteration must be accounted for exactly once"

        # The work is carried on the fold, not discarded with the steps that did it.
        iterations_counted = sum(
            e["delta"] for e in result["events"] if e["t"] == "metric" and e["name"] == "iteration"
        ) + sum(int((f.get("metrics") or {}).get("iteration", 0)) for f in folds)
        assert iterations_counted >= 500, iterations_counted

        # And a fold has to say where the span started and where it ended, or it cannot be stepped backwards.
        for fold in folds:
            for effect in fold["effects"]:
                assert "after" in effect, f"a fold left no final value for {effect.get('key')}"

        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert printed.strip() == str(sum(range(500)))

    def test_the_heap_holds_the_programs_data_and_not_the_jdks(self, client: Any) -> None:
        """A `String` is a value to everyone except the JVM, where it is an object full of bookkeeping.

        Left alone, `String label = "hi"` put a `String` in the heap pane carrying `coder`, `hash`,
        `hashIsZero` and a `byte[]` of character codes.
        """
        result = run_program(
            client,
            "public class Main {\n"
            "    public static void main(String[] args) {\n"
            "        String label = \"hi\";\n"
            "        Integer boxed = 7;\n"
            "        int[] numbers = {1, 2, 3};\n"
            "        System.out.println(label + boxed + numbers[0]);\n"
            "    }\n"
            "}\n",
            language="java",
        )
        announced = [e["type_name"] for e in result["events"] if e["t"] == "obj_new"]
        assert "String" not in announced
        assert "Integer" not in announced
        assert "int[]" in announced

        # And the values are still reported, as values.
        values = {
            e["name"]: e["value"]
            for e in result["events"]
            if e["t"] == "var_set" and e["name"] in ("label", "boxed")
        }
        assert values["label"] == {"prim": "hi"}
        assert values["boxed"] == {"prim": 7}


@needs_node
class TestRunningJavaScript:
    """The same seams as `TestRunning`, through the other adapter.

    These are not duplicates for the sake of symmetry. Everything from the spawn onwards is shared code
    reading a subprocess's stdout, and the *only* way to find out whether it is genuinely language-agnostic
    or merely Python-shaped is to put a second language through it. The first attempt at this failed at
    startup, because Node cannot boot under the address-space rlimit the server applied to every child.
    """

    def test_a_trace_survives_the_round_trip_intact(self, client: Any) -> None:
        result = run_program(
            client, "let x = 1;\nlet y = x + 2;\nconsole.log(y);\n", language="javascript"
        )
        assert not result["errors"], result["errors"]
        document = {
            "schema": result["header"]["schema"],
            "session": result["header"]["session"],
            "events": result["events"],
        }
        shape = validate_trace(document)
        assert shape.valid, shape.describe()
        coherence = check_trace_invariants(document)
        assert coherence.valid, coherence.describe()

    def test_the_header_says_which_language_ran(self, client: Any) -> None:
        session = client.post("/api/session").json()
        with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
            socket.send_json({"type": "run", "language": "javascript", "source": "let x = 1;\n"})
            first = socket.receive_json()
        assert first["type"] == "session"
        assert first["session"]["language"] == "javascript"
        assert first["session"]["language_version"].startswith("v"), "Node reports versions as vX.Y.Z"

    def test_program_output_is_relayed(self, client: Any) -> None:
        result = run_program(
            client, "for (let i = 0; i < 3; i++) {\n  console.log(i);\n}\n", language="javascript"
        )
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert printed == "0\n1\n2\n"

    def test_the_header_reports_the_guards_that_are_really_in_force(self, client: Any) -> None:
        result = run_program(client, "let x = 1;\n", language="javascript")
        guards = result["header"]["session"].get("guards_active")
        assert guards, "a run must state what was protecting it"
        joined = " ".join(guards).lower()
        # The permission model has to be on, or the run is unguarded and the UI would have to say so.
        assert "permission model" in joined
        assert "no sandbox" not in joined
        # And it must not claim the one thing node cannot do.
        assert "network not restricted" in joined

    def test_a_variable_declared_in_a_block_does_not_break_the_program(self, client: Any) -> None:
        """The instrumenter observes variables by naming them, so it has to know what is still in scope.

        Worth a server test and not only a unit test: this is the shape of almost every real JavaScript
        program, and when it was wrong the failure was a ReferenceError *in the user's program* rather than
        anything that looked like a flow_view bug.
        """
        result = run_program(
            client,
            "let x = 1;\nif (x > 0) {\n  let y = 2;\n  x = x + y;\n}\nconsole.log(x);\n",
            language="javascript",
        )
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert printed == "3\n"
        assert not [e for e in result["events"] if e["t"] == "exception_uncaught"]

    def test_an_infinite_loop_is_stopped_and_still_yields_a_usable_trace(self, client: Any) -> None:
        result = run_program(
            client,
            "let n = 0;\nwhile (true) {\n  n += 1;\n}\n",
            language="javascript",
            limits={"max_steps": 400},
        )
        end = [e for e in result["events"] if e["t"] == "run_end"]
        assert end and end[0]["status"] == "step_limit"
        document = {
            "schema": result["header"]["schema"],
            "session": result["header"]["session"],
            "events": result["events"],
        }
        # Balanced frames matter most here: a truncated run still has to close what it opened.
        assert check_trace_invariants(document).valid

    def test_a_failing_program_is_a_result_not_an_error(self, client: Any) -> None:
        result = run_program(
            client, "const v = [1];\nconsole.log(v[9].length);\n", language="javascript"
        )
        assert not result["errors"], "a program that throws is not a server error"
        end = [e for e in result["events"] if e["t"] == "run_end"]
        assert end[0]["status"] == "error"
        uncaught = [e for e in result["events"] if e["t"] == "exception_uncaught"]
        assert uncaught and uncaught[0]["type"] == "TypeError"
        assert uncaught[0]["stack"], "an uncaught exception must report where it happened"

    def test_a_syntax_error_is_reported_on_the_offending_program(self, client: Any) -> None:
        result = run_program(client, "function broken(\n", language="javascript")
        notes = [e["text"] for e in result["events"] if e["t"] == "note"]
        assert any("parse" in note.lower() for note in notes)

    def test_prefilled_stdin_produces_a_run_with_no_human_involved(self, client: Any) -> None:
        result = run_program(
            client,
            "const name = prompt('Name: ');\n"
            "const age = Number(prompt('Age: '));\n"
            "console.log(name, age);\n",
            language="javascript",
            stdin="Ada\n36\n",
        )
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert "Ada 36" in printed
        responses = [e for e in result["events"] if e["t"] == "stdin_response"]
        assert len(responses) == 2, "the answers must be recorded so a replay needs no human"
        # Labelled by the end that supplied them, not guessed at from how fast the read returned.
        assert [r["source"] for r in responses] == ["prefilled", "prefilled"]

    def test_a_long_loop_arrives_folded_and_still_reports_the_right_answer(
        self, client: Any
    ) -> None:
        """Collapsing, through the server, with the JavaScript collapser rather than the Python one."""
        result = run_program(
            client,
            "let total = 0;\nfor (let i = 0; i < 20000; i++) {\n  total += i;\n}\nconsole.log(total);\n",
            language="javascript",
        )
        assert not result["errors"], result["errors"]
        folds = [e for e in result["events"] if e["t"] == "collapse"]
        assert folds, "a twenty-thousand iteration loop must not arrive one step at a time"

        folded = sum(f["iterations"] for f in folds)
        verbatim = len([e for e in result["events"] if e["t"] == "loop_iter"])
        assert folded + verbatim == 20000, "every iteration must be accounted for exactly once"

        # The whole point of folding: the summary is shorter, and the answer is still exact.
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert printed.strip() == str(sum(range(20000)))

    def test_events_arrive_batched_rather_than_one_per_frame(self, client: Any) -> None:
        # One socket frame per event would spend more time framing than working.
        #
        # The program deliberately has no loop long enough to be folded. It used to be
        # `for i in range(120)`, which stopped producing enough events to say anything about batching
        # once loop collapsing arrived - the test was failing because a different feature had started
        # working, which is not a useful thing for a test to tell you.
        session = client.post("/api/session").json()
        batches = 0
        total = 0
        with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
            socket.send_json(
                {
                    "type": "run",
                    "language": "python",
                    "source": (
                        "def work(n):\n"
                        "    total = 0\n"
                        "    for i in range(15):\n"
                        "        total += i * n\n"
                        "    return total\n"
                        "\n"
                        "out = []\n"
                        "for k in range(19):\n"
                        "    out.append(work(k))\n"
                    ),
                }
            )
            while True:
                message = socket.receive_json()
                if message.get("type") == "events":
                    batches += 1
                    total += len(message["events"])
                elif message.get("type") in ("complete", "error"):
                    break
        assert total > 300
        assert batches < total, "events must be grouped, not sent individually"

    def test_a_long_loop_arrives_folded_and_still_reports_the_right_answer(
        self, client: Any
    ) -> None:
        """Loop collapsing, through the whole server path rather than in-process.

        Twenty thousand iterations is already more than a browser should be asked to hold one event at
        a time. What matters is that shortening the trace did not cost the answer: the sum is exact,
        and every iteration is still accounted for between the folds and the ones kept verbatim.
        """
        result = run_program(
            client,
            "total = 0\nfor i in range(20000):\n    total += i\nprint(total)\n",
        )
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert printed.strip() == str(sum(range(20000)))

        folds = [e for e in result["events"] if e["t"] == "collapse"]
        assert folds, "a 20000-iteration loop arrived unfolded"

        folded = sum(f["iterations"] for f in folds)
        verbatim = len([e for e in result["events"] if e["t"] == "loop_iter"])
        assert folded + verbatim == 20000, (
            f"{folded} folded plus {verbatim} kept is not 20000 - iterations went missing"
        )
        assert len(result["events"]) < 2000, (
            f"{len(result['events'])} events for 20000 iterations is not folded enough to help"
        )
        # The work is reported even though the steps are not.
        iterations = sum(
            int((f.get("metrics") or {}).get("iteration", 0)) for f in folds
        ) + sum(e["delta"] for e in result["events"] if e["t"] == "metric" and e["name"] == "iteration")
        assert iterations == 20000, f"the trace claims {iterations} iterations, not 20000"


class TestGuards:
    @pytest.mark.parametrize(
        ("label", "source"),
        [
            ("network", "import socket\ns = socket.socket()\n"),
            ("subprocess", "import os\nos.system('echo hi')\n"),
            ("write outside the run directory", "open('/tmp/fv_escape.txt', 'w').write('x')\n"),
        ],
    )
    def test_accidents_are_refused_with_an_explanation(
        self, client: Any, label: str, source: str
    ) -> None:
        result = run_program(client, source)
        uncaught = [e for e in result["events"] if e["t"] == "exception_uncaught"]
        assert uncaught, f"{label} should have been refused"
        assert "flow_view" in uncaught[0]["message"], "the refusal must say who refused and why"

    def test_writing_inside_the_run_directory_is_allowed(self, client: Any) -> None:
        # Reads and local writes are ordinary program behaviour; only escaping the directory is not.
        result = run_program(client, "open('out.txt', 'w').write('x')\nprint('wrote')\n")
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert "wrote" in printed



#: Execution budget for the tests below, in milliseconds.
#:
#: The runner gives up on a silent child after the budget plus five seconds. That is what guarantees
#: the server always eventually says something, which is what lets these tests wait on the socket
#: without a timeout of their own.
DEADLOCK_BUDGET_MS = 3000

#: How long these tests will let an unanswered question stand before the runner ends the run.
#:
#: The real value is fifteen minutes, because the alternative is interrupting somebody mid-thought.
#: A test cannot wait that long, so it shortens it.
TEST_UNANSWERED_DEADLINE = 20


def await_event(socket: Any, kind: str, *, limit: int = 400) -> dict[str, Any] | None:
    """Wait for one event of `kind`, or return None once the run is over without producing one.

    The `or return None` is the whole point, and it is why none of this needs a timeout.

    A loop that only looks for the event it wants will sit on `receive_json()` forever after the run has
    finished and the server has stopped talking. That is a hang, not a failure: it reports nothing and
    takes forever doing it. An earlier version of these tests wrapped the whole conversation in a
    thread with a deadline, which failed the test correctly and then wedged the socket, so the fixture
    teardown hung instead. Bounding the wait by *the run ending* rather than by elapsed time removes
    the need for the thread, because the runner's own deadline guarantees the run does end.
    """
    for _ in range(limit):
        message = socket.receive_json()
        kind_in = message.get("type")
        if kind_in == "events":
            for event in message["events"]:
                if event["t"] == kind:
                    return event
        elif kind_in in ("complete", "error", "stopped"):
            return None
    return None


@pytest.fixture
def impatient(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shorten the wait for an answer nobody gives, so a broken stdin path fails in seconds."""
    from flow_view_server import runner as runner_module

    monkeypatch.setattr(runner_module, "UNANSWERED_DEADLINE", TEST_UNANSWERED_DEADLINE)


class TestAProgramThatStopsToAskAQuestion:
    """Interactive input, which needs events to reach the browser *before* the program can continue.

    Three separate buffers used to swallow the question, and all three had to be fixed for any of
    this to work:

      - the tracer block-buffered its stdout, so the `stdin_request` sat in an 8 KB buffer;
      - this server batched events and only ever decided to flush when the *next* event arrived,
        which for a blocked program is never;
      - and prefilled input was written without the newline that `input()` needs to return.

    Each one on its own is enough to hang the run with the UI showing "running", so each one gets a
    test that fails rather than hangs.
    """

    def test_the_question_reaches_the_browser_before_the_answer_is_given(self, client: Any, impatient: None) -> None:
        session = client.post("/api/session").json()

        def conversation() -> dict[str, Any]:
            with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
                socket.send_json(
                    {
                        "type": "run",
                        "language": "python",
                        "source": 'age = input("how old? ")\nprint("in ten years:", int(age) + 10)\n',
                        # A short budget so a regression ends the child in seconds. Waiting on a
                        # person is discounted, so this does not constrain the conversation itself.
                        "limits": {"wall_ms": DEADLOCK_BUDGET_MS},
                    }
                )
                # Nothing has been sent as stdin. The request must still arrive, or there is no way
                # for anyone to know an answer is wanted.
                asked = await_event(socket, "stdin_request")
                if asked is None:
                    return {"asked": None, "events": [], "errors": [], "header": {}}
                socket.send_json({"type": "stdin", "text": "32"})
                return {"asked": asked, **collect(socket)}

        result = conversation()
        assert result["asked"] is not None, (
            "the program's question never reached the browser, so nobody could have answered it"
        )
        assert result["asked"]["prompt"] == "how old? "
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert "in ten years: 42" in printed
        answered = [e for e in result["events"] if e["t"] == "stdin_response"]
        assert [e["text"] for e in answered] == ["32"]
        assert answered[0]["source"] == "interactive"

    def test_a_partial_batch_is_sent_while_the_program_is_quiet(self, client: Any, impatient: None) -> None:
        """The deadlock in miniature: too few events to fill a batch, then silence.

        Whatever has been collected has to go out on the timer, not on the arrival of an event that
        will never come.

        This asks for a specific event rather than "anything at all". Written the loose way it passed
        even with the flush removed, because the timeout note the runner eventually produces counted as
        an arrival — a test that was satisfied by the run failing.
        """
        session = client.post("/api/session").json()

        def wait_for_the_assignment() -> dict[str, Any] | None:
            with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
                socket.send_json(
                    {
                        "type": "run",
                        "language": "python",
                        "source": 'x = 1\ny = input("more? ")\n',
                        "limits": {"wall_ms": DEADLOCK_BUDGET_MS},
                    }
                )
                # `x = 1` happens before the program blocks, so this event exists and is stuck in a
                # partial batch behind an event that will never arrive.
                return await_event(socket, "var_set")

        landed = wait_for_the_assignment()
        assert landed is not None, "a partial batch was held until the run ended"
        assert landed["name"] == "x"

    def test_a_slow_answer_does_not_end_the_run_for_being_unresponsive(self, client: Any, impatient: None) -> None:
        """Silence while waiting for a person is not a program that has hung.

        The read deadline is the execution budget plus five seconds, and it used to apply even while
        the program sat on a question. Take longer than that to answer and the run was killed with
        "The program stopped responding", which blamed the program for the time you spent reading.
        """
        import time

        session = client.post("/api/session").json()
        budget_ms = 100  # so the old deadline would have been ~5.1s

        def slow_conversation() -> dict[str, Any]:
            with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
                socket.send_json(
                    {
                        "type": "run",
                        "language": "python",
                        "source": 'n = input("n? ")\nprint("got", n)\n',
                        "limits": {"wall_ms": budget_ms},
                    }
                )
                if await_event(socket, "stdin_request") is None:
                    return {"asked": False, "events": [], "errors": [], "header": {}}
                # Longer than the old deadline, and far longer than the execution budget.
                time.sleep(7)
                socket.send_json({"type": "stdin", "text": "4"})
                return {"asked": True, **collect(socket)}

        result = slow_conversation()
        assert result["asked"], "the question never arrived, so this proves nothing about waiting"
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert "got 4" in printed
        complaints = [
            e["text"]
            for e in result["events"]
            if e["t"] == "note" and "stopped responding" in e.get("text", "")
        ]
        assert not complaints, f"the run was blamed for waiting: {complaints}"

    def test_prefilled_input_without_a_trailing_newline_still_completes(self, client: Any, impatient: None) -> None:
        # The input box is a textarea. A user who types one value and presses Run leaves no newline,
        # and `input()` reads a *line*, so the run used to hang forever on a read that could not
        # return.
        result = run_program(
            client,
            'name = input()\nprint("hello", name)\n',
            stdin="Ada",
            limits={"wall_ms": DEADLOCK_BUDGET_MS},
        )
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert "hello Ada" in printed

    def test_several_prefilled_values_without_a_final_newline_all_arrive(self, client: Any, impatient: None) -> None:
        result = run_program(
            client,
            "a = input()\nb = input()\nprint(int(a) + int(b))\n",
            stdin="20\n22",
            limits={"wall_ms": DEADLOCK_BUDGET_MS},
        )
        printed = "".join(e["text"] for e in result["events"] if e["t"] == "stdout")
        assert "42" in printed
