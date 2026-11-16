"""Native debugger MI output must preserve observed values and diagnostics."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flow_view_native.mi import MIClient, Record, parse_record


def test_stop_with_nested_frame_and_escaped_text() -> None:
    record = parse_record(
        '12*stopped,reason="breakpoint-hit",frame={addr="0x7ff",func="main",'
        'args=[{name="x",value="a,b\\"c"}],file="main.c",line="7"}'
    )
    assert record == Record(
        12,
        "*",
        "stopped",
        {
            "reason": "breakpoint-hit",
            "frame": {
                "addr": "0x7ff",
                "func": "main",
                "args": [{"name": "x", "value": 'a,b"c'}],
                "file": "main.c",
                "line": "7",
            },
        },
    )


def test_results_streams_repeated_keys_and_prompt() -> None:
    assert parse_record("(gdb) ") is None
    assert parse_record('3^done,stack=[frame={level="0"},frame={level="1"}]').value == {
        "stack": {"frame": [{"level": "0"}, {"level": "1"}]}
    }
    assert parse_record('~"stdout\\n"') == Record(None, "~", None, "stdout\n")
    assert parse_record('7^error,msg="Cannot access memory at address 0x0"').value == {
        "msg": "Cannot access memory at address 0x0"
    }


@pytest.mark.parametrize("invalid", ["garbage", "^done,frame={", '~"broken', '^done,x="a"junk'])
def test_malformed_records_rejected(invalid: str) -> None:
    with pytest.raises(ValueError):
        parse_record(invalid)


def test_output_watch_reaps_debugger_after_file_limit(tmp_path: Path) -> None:
    if not shutil.which("gdb"):
        pytest.skip("GDB required")
    output = tmp_path / "stdout"
    errors = tmp_path / "stderr"
    output.write_bytes(b"")
    errors.write_bytes(b"")
    with MIClient(timeout=5) as debugger:
        debugger.watch_output((output, errors), 32)
        output.write_bytes(b"x" * 65537)
        deadline = time.monotonic() + 5
        while not debugger.output_exceeded and time.monotonic() < deadline:
            time.sleep(0.02)
        assert debugger.output_exceeded
        debugger.process.wait(timeout=5)


def test_real_gdb_steps_compiled_c_and_reads_observed_locals(tmp_path: Path) -> None:
    if not shutil.which("gdb") or not shutil.which("gcc"):
        pytest.skip("C compiler and GDB required")
    source = tmp_path / "main.c"
    source.write_text("int main(void) {\n int n=2;\n n=n+1;\n return n;\n}\n", encoding="utf-8")
    binary = tmp_path / ("main.exe" if sys.platform == "win32" else "main")
    subprocess.run(["gcc", "-g", "-O0", str(source), "-o", str(binary)], check=True, timeout=20)

    with MIClient(timeout=20) as debugger:
        loaded, _ = debugger.command(f"-file-exec-and-symbols {json.dumps(binary.as_posix())}")
        assert loaded.name == "done"
        assert debugger.command("-break-insert main")[0].name == "done"
        assert debugger.command("-exec-run")[0].name == "running"
        stopped, _output = debugger.stop()
        assert stopped.value["frame"]["func"] == "main"
        assert debugger.command("-exec-next")[0].name == "running"
        stopped, _output = debugger.stop()
        assert stopped.value["frame"]["line"] == "3"
        result, _output = debugger.command("-stack-list-variables --all-values")
        assert {v["name"]: v["value"] for v in result.value["variables"]}["n"] == "2"
