"""End-to-end C++ debugger tests against compiled programs and Universal Trace."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/trace-schema/python"))
from flow_view_schema import check_trace_invariants, validate_trace  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def toolchain() -> None:
    if not shutil.which("g++") or not shutil.which("gdb"):
        pytest.skip("C++ compiler and GDB required")


def trace_cpp(tmp_path: Path, source: str, *, stdin: str = "") -> list[dict]:
    program = tmp_path / "main.cpp"
    program.write_text(source, encoding="utf-8")
    result = subprocess.run(
        [
            sys.executable,
            "-I",
            str(ROOT / "adapters/native/flow_view_native/cli.py"),
            "--source",
            str(program),
        ],
        input=stdin,
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=45,
    )
    assert not result.stderr, result.stderr[-1000:]
    records = [json.loads(line) for line in result.stdout.splitlines()]
    assert records and records[0]["session"]["language"] == "cpp"
    trace = {**records[0], "events": records[1:]}
    assert validate_trace(trace).valid, validate_trace(trace).describe()
    assert check_trace_invariants(trace).valid, check_trace_invariants(trace).describe()
    return records[1:]


def test_constructor_destructor_and_heap_lifetime(tmp_path: Path) -> None:
    events = trace_cpp(
        tmp_path,
        "#include <iostream>\nstruct Node { int value; Node(int n):value(n){} "
        "~Node(){value=-1;} };\nint main(){\nNode *p=new Node(3);\n"
        "std::cout<<p->value;\ndelete p;\nreturn 0;\n}\n",
    )
    assert events[-1]["status"] == "ok"
    assert [(e["via"]) for e in events if e["t"] == "mem_alloc"] == ["new"]
    assert [(e["via"]) for e in events if e["t"] == "mem_free"] == ["delete"]
    assert [(e["kind"], e["type_name"]) for e in events if e["t"] == "obj_new"] == [
        ("instance", "Node")
    ]
    assert any(e["t"] == "frame_push" and e["kind"] == "constructor" for e in events)
    assert any(e["t"] == "frame_push" and e["func"] == "Node::~Node" for e in events)
    assert any(
        e["t"] == "var_set" and e["name"] == "p" and e["value"].get("dangling") for e in events
    )
    assert "".join(e["text"] for e in events if e["t"] == "stdout") == "3"


def test_cpp_cin_stops_for_replayable_input(tmp_path: Path) -> None:
    events = trace_cpp(
        tmp_path,
        '#include <iostream>\nint main(){\nint n=0;\nstd::cout<<"Age: ";\n'
        "std::cin>>n;\nstd::cout<<n*2;\nreturn 0;\n}\n",
        stdin="21\n",
    )
    requests = [e for e in events if e["t"] == "stdin_request"]
    assert len(requests) == 1 and requests[0]["prompt"]
    assert [e["text"] for e in events if e["t"] == "stdin_response"] == ["21"]
    assert "".join(e["text"] for e in events if e["t"] == "stdout") == "Age: 42"


def test_caught_and_uncaught_cpp_exceptions(tmp_path: Path) -> None:
    caught = trace_cpp(
        tmp_path,
        "#include <stdexcept>\n#include <iostream>\n"
        'int f(){throw std::runtime_error("oops");}\n'
        "int main(){try{f();}catch(const std::runtime_error&){"
        'std::cout<<"caught";}return 0;}',
    )
    assert caught[-1]["status"] == "ok"
    assert [e["t"] for e in caught if e["t"].startswith("exception_")] == [
        "exception_raise",
        "exception_catch",
    ]
    assert "".join(e["text"] for e in caught if e["t"] == "stdout") == "caught"
    uncaught = trace_cpp(
        tmp_path, '#include <stdexcept>\nint main(){throw std::runtime_error("oops");}'
    )
    assert uncaught[-1]["status"] == "error"
    assert [e["type"] for e in uncaught if e["t"] == "exception_uncaught"] == [
        "std::runtime_error"
    ], [(e["t"], e.get("type"), e.get("text")) for e in uncaught
        if e["t"].startswith("exception_") or e["t"] == "note"]


def test_std_vector_reports_elements_and_lifetime(tmp_path: Path) -> None:
    events = trace_cpp(
        tmp_path,
        "#include <vector>\n#include <iostream>\nint main(){\n"
        "std::vector<int> v={1,2};\nv.push_back(3);\n"
        "std::cout<<v[2];\nreturn 0;\n}\n",
    )
    objects = [e for e in events if e["t"] == "obj_new"]
    assert len(objects) == 1 and objects[0]["kind"] == "array"
    assert objects[0]["type_name"].startswith("std::vector<int")
    assert any(e["t"] == "obj_resize" and e["length"] == 3 for e in events)
    slots = [e for e in events if e["t"] == "obj_set"]
    assert {e["key"]: e["value"] for e in slots} == {
        "0": {"prim": 1},
        "1": {"prim": 2},
        "2": {"prim": 3},
    }
    assert len([e for e in events if e["t"] == "obj_free"]) == 1
    assert "".join(e["text"] for e in events if e["t"] == "stdout") == "3"


def test_cpp_method_return_is_observed(tmp_path: Path) -> None:
    events = trace_cpp(
        tmp_path,
        "#include <iostream>\nstruct Counter {\n int value;\n"
        " Counter(int n):value(n){}\n int get() const {\n return value;\n }\n};\n"
        "int main(){\nCounter *p=new Counter(7);\nint answer=p->get();\n"
        "std::cout<<answer;\ndelete p;\nreturn 0;\n}\n",
    )
    pushes = [e for e in events if e["t"] == "frame_push" and "::get" in e["func"]]
    assert pushes and pushes[0]["kind"] == "method"
    assert any(
        e["t"] == "frame_pop"
        and e["frame"] == pushes[0]["frame"]
        and e.get("return_value") == {"prim": 7}
        for e in events
    )
    assert "".join(e["text"] for e in events if e["t"] == "stdout") == "7"


def test_std_map_reports_size_and_unavailable_entries(tmp_path: Path) -> None:
    events = trace_cpp(
        tmp_path,
        "#include <map>\n#include <iostream>\nint main(){\n"
        "std::map<int,int> m;\nm[1]=10;\nm[2]=20;\n"
        "std::cout<<m[2];\nreturn 0;\n}\n",
    )
    objects = [e for e in events if e["t"] == "obj_new" and e["kind"] == "map"]
    assert len(objects) == 1 and objects[0]["type_name"].startswith("std::map<int, int")
    assert any(e["t"] == "obj_resize" and e["length"] == 2 for e in events)
    assert any(
        e["t"] == "obj_set" and e["key"] == "entries" and "unavailable" in e["value"]
        for e in events
    )
    assert len([e for e in events if e["t"] == "obj_free"]) == 1
    assert "".join(e["text"] for e in events if e["t"] == "stdout") == "20"


def test_reference_alias_and_array_delete(tmp_path: Path) -> None:
    events = trace_cpp(
        tmp_path,
        "#include <iostream>\nint main(){\nint *p=new int[3];\n"
        "p[0]=2; p[1]=4; p[2]=6;\nint &alias=p[1];\n"
        "alias=8;\nstd::cout<<p[1];\ndelete[] p;\nreturn 0;\n}\n",
    )
    assert events[-1]["status"] == "ok"
    assert any(e["t"] == "mem_alloc" and e["via"] == "new_array" for e in events)
    assert any(e["t"] == "mem_free" and e["via"] == "delete_array" for e in events)
    assert any(
        e["t"] == "var_set" and e["name"] == "alias" and "addr" in e["value"] for e in events
    )
    assert "".join(e["text"] for e in events if e["t"] == "stdout") == "8"
