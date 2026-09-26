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
        session = client.post("/api/session").json()
        batches = 0
        total = 0
        with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
            socket.send_json(
                {
                    "type": "run",
                    "language": "python",
                    "source": "t = 0\nfor i in range(120):\n    t += i\n",
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
