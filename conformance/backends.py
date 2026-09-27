"""Comparing the two tracing backends.

Reproduces the measurements behind ``docs/decisions/0002-tracing-backend.md``: how closely the
``settrace`` and ``sys.monitoring`` backends agree, and what monitoring actually buys.

Run directly for the report; the assertions live in ``tests/test_backends.py`` so a change in CPython
becomes a failing test rather than something a user notices.

    python conformance/backends.py
"""

from __future__ import annotations

import statistics
import sys
import time
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "adapters" / "python"))

from flow_view_tracer.backends import monitoring_available  # noqa: E402
from flow_view_tracer.emit import Limits  # noqa: E402
from flow_view_tracer.tracer import TracerOptions, run_source  # noqa: E402

#: Fields that legitimately differ between two runs of the same program.
VOLATILE = {"ms", "duration_ms"}

#: Constructs the two backends agree on exactly.
AGREEING = {
    "assignment": "x = 1\ny = x + 2\nprint(y)\n",
    "rebinding": "n = 0\nn = n + 5\nn = n * 3\n",
    "branching": "s = 72\nif s >= 90:\n    g = 'A'\nelif s >= 70:\n    g = 'B'\n",
    "for loop": "t = 0\nfor i in range(4):\n    t += i\n",
    "while loop": "n = 0\nwhile n < 3:\n    n += 1\n",
    "break": "for i in range(5):\n    if i == 2:\n        break\n",
    "continue": "s = 0\nfor i in range(4):\n    if i == 1:\n        continue\n    s += 1\n",
    "function": "def add(a, b):\n    return a + b\nr = add(3, 4)\n",
    "recursion": "def f(n):\n    return 1 if n <= 1 else n * f(n - 1)\nr = f(4)\n",
    "nested function": "def o():\n    def i(k):\n        return k * 2\n    return i(3)\nr = o()\n",
    "aliasing": "a = [1]\nb = a\nb.append(2)\n",
    "class": "class N:\n    def __init__(self, v):\n        self.v = v\nn = N(3)\n",
    "caught exception": "try:\n    1 / 0\nexcept ZeroDivisionError:\n    r = None\n",
    "uncaught exception": "v = [1]\nprint(v[9])\n",
    "generator": "def g():\n    yield 1\n    yield 2\nv = list(g())\n",
    "repeated library calls": (
        "import json\nout = []\nfor i in range(5):\n    out.append(json.dumps({'i': i}))\n"
    ),
}

#: Constructs where they cannot agree, and why.
#:
#: Monitoring's LINE event fires when execution moves *to* a line, not every time it re-enters one, so a
#: loop written on a single line is reported as one step. settrace reports every iteration.
DIVERGING = {
    "comprehension": "sq = [i * i for i in range(3)]\n",
    "one-line for": "t = 0\nfor i in range(3): t += i\n",
}

#: Programs used for the timing comparison.
TIMED = {
    "tight loop": "t = 0\nfor i in range(400):\n    t += i\n",
    "heap building": "n = []\nfor i in range(200):\n    n.append({'i': i})\n",
    "repeated library calls": (
        "import json\no = []\nfor i in range(80):\n    o.append(json.dumps({'i': i}))\n"
    ),
}


def trace(source: str, backend: str) -> list[dict[str, Any]]:
    """Trace a program with one backend, stripped of anything that legitimately varies."""
    events: list[dict[str, Any]] = []
    run_source(
        source,
        "main.py",
        on_event=events.append,
        limits=Limits(max_steps=100_000),
        options=TracerOptions(backend=backend),
    )
    return [
        {key: value for key, value in event.items() if key not in VOLATILE}
        for event in events
        if "session" not in event
    ]


def first_difference(left: list[dict], right: list[dict]) -> str:
    for index, (a, b) in enumerate(zip(left, right)):
        if a != b:
            return f"event {index}:\n      settrace   {a}\n      monitoring {b}"
    extra = left[len(right) :] or right[len(left) :]
    return f"one stream is longer; first extra event: {extra[0] if extra else 'none'}"


def step_count(events: list[dict]) -> int:
    return len([event for event in events if "step" in event])


def report() -> int:
    if not monitoring_available():
        print(f"sys.monitoring needs Python 3.12+; this is {sys.version.split()[0]}")
        return 0

    print(f"python {sys.version.split()[0]}\n")
    print("=== where the backends agree ===")
    disagreements = 0
    for name, source in AGREEING.items():
        settrace, monitoring = trace(source, "settrace"), trace(source, "monitoring")
        if settrace == monitoring:
            print(f"  identical  {name:<24} ({len(settrace)} events)")
        else:
            disagreements += 1
            print(f"  DIFFERENT  {name:<24} {first_difference(settrace, monitoring)}")

    print("\n=== where they cannot ===")
    for name, source in DIVERGING.items():
        settrace, monitoring = trace(source, "settrace"), trace(source, "monitoring")
        print(
            f"  {name:<24} settrace {step_count(settrace)} steps, "
            f"monitoring {step_count(monitoring)} steps"
        )
    print("  monitoring reports a single-line loop as one step, hiding every iteration.")

    print("\n=== what monitoring buys ===")
    for name, source in TIMED.items():
        timings: dict[str, float] = {}
        steps: dict[str, int] = {}
        for backend in ("settrace", "monitoring"):
            samples = []
            events: list[dict] = []
            for _ in range(5):
                started = time.perf_counter()
                events = trace(source, backend)
                samples.append((time.perf_counter() - started) * 1000)
            timings[backend] = statistics.median(samples)
            steps[backend] = step_count(events)
        ratio = timings["settrace"] / timings["monitoring"]
        print(
            f"  {name:<24} settrace {timings['settrace']:>6.1f}ms  "
            f"monitoring {timings['monitoring']:>6.1f}ms  -> {ratio:.2f}x"
        )
        if steps["settrace"] != steps["monitoring"]:
            print(
                f"  {'':<24} WARNING: step counts differ "
                f"({steps['settrace']} vs {steps['monitoring']}) — "
                "a speedup that drops work is not a speedup"
            )

    print(
        "\nConclusion: about a tenth faster, at the cost of hiding loop iterations. "
        "settrace stays the default. See docs/decisions/0002-tracing-backend.md"
    )
    return 1 if disagreements else 0


if __name__ == "__main__":
    raise SystemExit(report())
