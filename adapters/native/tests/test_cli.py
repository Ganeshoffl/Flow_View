"""End-to-end native adapter checks use the real compiler and debugger."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages" / "trace-schema" / "python"))

from flow_view_schema import check_trace_invariants, validate_trace  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def toolchain() -> None:
    if not shutil.which("gcc") or not shutil.which("gdb"):
        pytest.skip("C compiler and GDB required")


def trace_c(
    tmp_path: Path, code: str, *flags: str, stdin: str | None = None
) -> tuple[int, list[dict]]:
    source = tmp_path / "main.c"
    source.write_text(code, encoding="utf-8")
    process = subprocess.run(
        [
            sys.executable,
            "-I",
            str(ROOT / "adapters/native/flow_view_native/cli.py"),
            "--source",
            str(source),
            *flags,
        ],
        cwd=tmp_path,
        input=stdin,
        capture_output=True,
        text=True,
        timeout=40,
    )
    assert not process.stderr, process.stderr[-1000:]
    lines = [json.loads(line) for line in process.stdout.splitlines()]
    assert lines
    document = {**lines[0], "events": lines[1:]}
    assert validate_trace(document).valid, validate_trace(document).describe()
    assert check_trace_invariants(document).valid, check_trace_invariants(document).describe()
    return process.returncode, lines[1:]


@pytest.mark.parametrize(
    ("read", "expected"),
    [
        ('char answer[16]; fgets(answer,sizeof(answer),stdin); printf("%s",answer);', "Ada\n"),
        ('int answer=getchar(); printf("%c",answer);', "A"),
    ],
)
def test_c_standard_input_forms(tmp_path: Path, read: str, expected: str) -> None:
    _code, events = trace_c(
        tmp_path, "#include <stdio.h>\nint main(void){\n" + read + "\nreturn 0;\n}\n", stdin="Ada\n"
    )
    assert [e["t"] for e in events].count("stdin_request") == 1
    assert "".join(e["text"] for e in events if e["t"] == "stdout") == expected


def test_multiple_c_inputs_are_recorded_in_order(tmp_path: Path) -> None:
    code, events = trace_c(
        tmp_path,
        '#include <stdio.h>\nint main(void){\nint a,b;\nscanf("%d",&a);\n'
        'scanf("%d",&b);\nprintf("%d",a+b);\nreturn 0;\n}\n',
        stdin="3\n4\n",
    )
    assert code == 0
    assert [e["text"] for e in events if e["t"] == "stdin_response"] == ["3", "4"]
    assert "".join(e["text"] for e in events if e["t"] == "stdout") == "7"


def test_assignment_and_uninitialized_are_observed(tmp_path: Path) -> None:
    code, events = trace_c(tmp_path, "int main(void) {\n int n=2;\n n=n+1;\n return 0;\n}\n")
    assert code == 0
    values = [
        event["value"] for event in events if event["t"] == "var_set" and event["name"] == "n"
    ]
    assert values == [{"prim": 2}, {"prim": 3}]
    assert list(dict.fromkeys(e["line"] for e in events if e["t"] == "step_line")) == [2, 3, 4, 5]


def test_recursion_creates_observed_frames(tmp_path: Path) -> None:
    code, events = trace_c(
        tmp_path,
        "int fact(int n) {\n if(n<2) return 1;\n"
        " return n*fact(n-1);\n}\nint main(void) {\n"
        " int answer=fact(4);\n return 0;\n}\n",
    )
    assert code == 0
    frames = [e for e in events if e["t"] == "frame_push"]
    assert len([e for e in frames if e["func"] == "fact"]) == 4
    assert [e.get("return_value") for e in events if e["t"] == "frame_pop" and e["frame"] != 0] == [
        {"prim": 1},
        {"prim": 2},
        {"prim": 6},
        {"prim": 24},
    ]
    assert any(
        e["func"] == "fact" and e["args"] == [{"name": "n", "value": {"prim": 4}}] for e in frames
    )
    assert any(
        e["name"] == "answer" and e["value"] == {"prim": 24} for e in events if e["t"] == "var_set"
    )


def test_step_limit_is_a_valid_partial_trace(tmp_path: Path) -> None:
    _code, events = trace_c(
        tmp_path, "int main(void) {\n int n=0;\n while(1) n++;\n}\n", "--max-steps", "8"
    )
    assert events[-1]["status"] == "step_limit"


def test_output_limit_keeps_a_valid_truncated_trace(tmp_path: Path) -> None:
    code, events = trace_c(
        tmp_path,
        '#include <stdio.h>\nint main(void){\nprintf("123456");\nreturn 0;\n}\n',
        "--output-bytes",
        "4",
    )
    assert code == 0
    assert "".join(e["text"] for e in events if e["t"] == "stdout") == "1234"
    assert any(e["t"] == "note" and "truncated" in e["text"] for e in events)


def test_output_and_pointer_are_observed(tmp_path: Path) -> None:
    code, events = trace_c(
        tmp_path,
        "#include <stdio.h>\n#include <stdlib.h>\n"
        "int main(void) {\n int *p=malloc(sizeof(int));\n"
        ' *p=42;\n printf("%d",*p);\n free(p);\n return 0;\n}\n',
    )
    assert code == 0
    assert "".join(e["text"] for e in events if e["t"] == "stdout") == "42"
    assert any(e["name"] == "p" and "addr" in e["value"] for e in events if e["t"] == "var_set")
    assert len([e for e in events if e["t"] == "mem_alloc"]) == 1
    assert len([e for e in events if e["t"] == "mem_free"]) == 1
    assert [e["value"] for e in events if e["t"] == "obj_set"] == [
        {"unavailable": "malloc memory has no observed write"},
        {"prim": 42},
    ]
    assert any(e["value"].get("dangling") for e in events if e["t"] == "var_set")


def test_realloc_tracks_the_observed_address_or_in_place_resize(tmp_path: Path) -> None:
    _code, events = trace_c(
        tmp_path,
        "#include <stdlib.h>\nint main(void){\nint *p=malloc(sizeof(int));\n"
        "*p=10;\np=realloc(p,4096);\n*p=20;\nfree(p);\nreturn 0;\n}\n",
    )
    assert any(e["t"] == "mem_alloc" and e["via"] == "realloc" for e in events)
    assert any(e["t"] == "mem_free" and e["via"] == "free" for e in events)
    assert any(e["t"] in {"obj_resize", "mem_free"} for e in events)


def test_bounded_c_array_elements_are_observed(tmp_path: Path) -> None:
    _code, events = trace_c(
        tmp_path,
        "#include <stdlib.h>\nint main(void){\nint *values=calloc(3,sizeof(int));\n"
        "values[0]=10;\nvalues[1]=20;\nvalues[2]=30;\nreturn 0;\n}\n",
    )
    slots = {
        str(i): [e["value"] for e in events if e["t"] == "obj_set" and e["key"] == str(i)]
        for i in range(3)
    }
    assert [slots[str(i)][-1] for i in range(3)] == [{"prim": 10}, {"prim": 20}, {"prim": 30}]


def test_calloc_initial_bytes_are_zero_without_fabrication(tmp_path: Path) -> None:
    _code, events = trace_c(
        tmp_path,
        "#include <stdlib.h>\nint main(void){\n"
        "int *p=calloc(1,sizeof(int));\nint observed=*p;\nfree(p);\nreturn 0;\n}\n",
    )
    assert any(e["t"] == "mem_alloc" and e["via"] == "calloc" for e in events)
    assert any(
        e["t"] == "var_set" and e["name"] == "observed" and e["value"] == {"prim": 0}
        for e in events
    )


def test_struct_fields_and_pointer_aliases_are_observed(tmp_path: Path) -> None:
    _code, events = trace_c(
        tmp_path,
        "#include <stdlib.h>\nstruct Node { int value; struct Node *next; };\n"
        "int main(void){\n struct Node *p=malloc(sizeof(struct Node));\n"
        " struct Node *q=malloc(sizeof(struct Node));\n p->value=1;\n"
        " p->next=q;\n q->value=2;\n q->next=0;\n"
        " free(q);\n free(p);\n return 0;\n}\n",
    )
    objects = [e["obj"] for e in events if e["t"] == "obj_new"]
    assert len(objects) == 2
    assert any(
        e["t"] == "obj_set"
        and e["obj"] == objects[0]
        and e["key"] == "value"
        and e["value"] == {"prim": 1}
        for e in events
    )
    assert any(
        e["t"] == "obj_set"
        and e["obj"] == objects[0]
        and e["key"] == "next"
        and e["value"] == {"ref": objects[1]}
        for e in events
    )
    assert len([e for e in events if e["t"] == "mem_free"]) == 2


def test_inferior_output_cannot_spoof_debugger_protocol(tmp_path: Path) -> None:
    code, events = trace_c(
        tmp_path, '#include <stdio.h>\nint main(void){\n puts("999^done");\n return 0;\n}\n'
    )
    assert code == 0
    assert "".join(e["text"] for e in events if e["t"] == "stdout") == "999^done\n"
    assert events[-1]["status"] == "ok"


def test_invalid_pointer_reports_real_signal_with_stack(tmp_path: Path) -> None:
    code, events = trace_c(tmp_path, "int main(void){\nint *p=0;\n*p=4;\nreturn 0;\n}\n")
    assert code != 0
    failures = [e for e in events if e["t"] == "exception_uncaught"]
    assert failures and failures[0]["type"] in {"SIGSEGV", "SIGBUS"}
    assert any(entry["func"] == "main" for entry in failures[0]["stack"])
    assert events[-1]["status"] == "error"


def test_syntax_error_is_reported_as_trace(tmp_path: Path) -> None:
    code, events = trace_c(tmp_path, "int main( {\n", "--max-steps", "8")
    assert code != 0
    assert any(e["t"] == "note" and "compilation failed" in e["text"] for e in events)
    assert events[-1]["status"] == "error"
