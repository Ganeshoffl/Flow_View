"""Smoke-test installed JavaScript, C and C++ adapters outside the source checkout."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit("usage: verify-wheel.py <installed-wheel-site-directory>")

site = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(site))

from fastapi.testclient import TestClient  # noqa: E402
from flow_view_schema import check_trace_invariants, validate_trace  # noqa: E402
from flow_view_server.app import create_app  # noqa: E402
from flow_view_server.runner import c_adapter_cli, javascript_adapter_root  # noqa: E402

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

assert c_adapter_cli() == site / "flow_view_native" / "cli.py"
if shutil.which("gcc") and shutil.which("gdb"):
    with TestClient(create_app()) as client:
        session = client.post("/api/session").json()
        with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
            socket.send_json({"type": "run", "language": "c", "stdin": "21\n", "source":
                              '#include <stdio.h>\nint main(void){\nint n=0;\n'
                              'scanf("%d",&n);\nprintf("%d",n*2);\nreturn 0;\n}\n'})
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
                raise AssertionError("C run never completed")
    assert header is not None
    trace = {"schema": header["schema"], "session": header["session"], "events": events}
    assert validate_trace(trace).valid
    assert check_trace_invariants(trace).valid
    assert [event["text"] for event in events if event["t"] == "stdin_response"] == ["21"]
    assert "".join(event["text"] for event in events if event["t"] == "stdout") == "42"
    assert events[-1]["t"] == "run_end" and events[-1]["status"] == "ok"
    print("Installed wheel: C tracing, stdin, and trace invariants passed")

if shutil.which("g++") and shutil.which("gdb"):
    with TestClient(create_app()) as client:
        session = client.post("/api/session").json()
        with client.websocket_connect(f"/api/session/{session['id']}/ws") as socket:
            socket.send_json({"type": "run", "language": "cpp", "stdin": "21\n", "source":
                              '#include <iostream>\nint main(){\nint n=0;\n'
                              'std::cin>>n;\nstd::cout<<n*2;\nreturn 0;\n}\n'})
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
                raise AssertionError("C++ run never completed")
    assert header is not None and header["session"]["language"] == "cpp"
    trace = {"schema": header["schema"], "session": header["session"], "events": events}
    assert validate_trace(trace).valid and check_trace_invariants(trace).valid
    assert [event["text"] for event in events if event["t"] == "stdin_response"] == ["21"]
    assert "".join(event["text"] for event in events if event["t"] == "stdout") == "42"
    assert events[-1]["t"] == "run_end" and events[-1]["status"] == "ok"
    print("Installed wheel: C++ tracing, cin, and trace invariants passed")
