"""Smoke-test the installed wheel's JavaScript adapter outside the source checkout."""

from __future__ import annotations

import sys
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit("usage: verify-wheel.py <installed-wheel-site-directory>")

site = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(site))

from fastapi.testclient import TestClient  # noqa: E402
from flow_view_schema import check_trace_invariants, validate_trace  # noqa: E402
from flow_view_server.app import create_app  # noqa: E402
from flow_view_server.runner import javascript_adapter_root  # noqa: E402

root = javascript_adapter_root()
assert root == site / "flow_view_server" / "js", root

with TestClient(create_app()) as client:
    session = client.post("/api/session").json()
    with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
        socket.send_json({
            "type": "run",
            "language": "javascript",
            "source": "const x = prompt('Name?');\nconst y = prompt('Age?');\nconsole.log(x, y);\n",
            "stdin": "Ada\r\n36\r\n",
        })
        header = None
        events = []
        for _ in range(4000):
            message = socket.receive_json()
            if message["type"] == "session":
                header = message
            elif message["type"] == "events":
                events.extend(message["events"])
            elif message["type"] == "error":
                raise AssertionError(message)
            elif message["type"] == "complete":
                break
        else:
            raise AssertionError("JavaScript run never completed")

assert header is not None
trace = {"schema": header["schema"], "session": header["session"], "events": events}
assert validate_trace(trace).valid
assert check_trace_invariants(trace).valid
assert [event["text"] for event in events if event["t"] == "stdin_response"] == ["Ada", "36"]
assert "".join(event["text"] for event in events if event["t"] == "stdout") == "Ada 36\n"
assert events[-1]["t"] == "run_end" and events[-1]["status"] == "ok"
print("Installed wheel: JavaScript tracing, CRLF stdin, and trace invariants passed")
