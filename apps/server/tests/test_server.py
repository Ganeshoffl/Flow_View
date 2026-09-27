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


def run_program(client: Any, source: str, **extra: Any) -> dict[str, Any]:
    session = client.post("/api/session").json()
    with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
        socket.send_json({"type": "run", "language": "python", "source": source, **extra})
        return collect(socket)


class TestCapabilities:
    def test_python_is_available(self, client: Any) -> None:
        payload = client.get("/api/capabilities").json()
        python = next(item for item in payload["languages"] if item["language"] == "python")
        assert python["available"] is True
        assert python["version"]

    def test_unbuilt_languages_say_so_and_name_the_phase(self, client: Any) -> None:
        # A language that is merely not built yet must not look like a broken installation.
        payload = client.get("/api/capabilities").json()
        for language in ("javascript", "c", "cpp", "java"):
            item = next(i for i in payload["languages"] if i["language"] == language)
            assert item["available"] is False
            assert item["reason"]
            assert item["planned"]

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
        assert "not available yet" in result["errors"][0]["message"]

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
