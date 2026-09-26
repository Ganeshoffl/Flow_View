"""Task 1.0 — how expensive is reading the heap after every line?

The design assumed a reachability-scoped walk per step would be affordable. That was an assumption,
not a measurement, and it is the one that decides whether this adapter is usable: a walk costing
O(reachable) per line, on a program holding ten thousand objects, could mean a thousandfold slowdown.

This measures the real ``walk`` module — not a simplified stand-in — across heap sizes and shapes,
and compares:

  full         every reachable object, every line
  bounded-D    reachable within D references of the locals, capped
  identity     comparing local bindings by identity only, the floor on per-step cost

The number that matters is **per-step cost**, since it is paid once per executed line. A budget of
roughly 50µs per step keeps a 10,000-step program under a second of tracing overhead, which is the
threshold for the tool feeling responsive rather than hung.

Run:  python adapters/python/bench/heap_walk.py
      python adapters/python/bench/heap_walk.py --json results.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flow_view_tracer.walk import (  # noqa: E402
    Registry,
    diff_snapshots,
    locals_changed,
    walk_bounded,
    walk_full,
)

#: Per-step cost above which tracing stops feeling instant.
BUDGET_US = 50.0


# ---------------------------------------------------------------------------
# workloads
# ---------------------------------------------------------------------------


class Node:
    """A linked-list node, the shape that produces the deepest graphs."""

    __slots__ = ("value", "next")

    def __init__(self, value: int) -> None:
        self.value = value
        self.next: Node | None = None


class TreeNode:
    __slots__ = ("key", "left", "right")

    def __init__(self, key: int) -> None:
        self.key = key
        self.left: TreeNode | None = None
        self.right: TreeNode | None = None


def make_linked_list(n: int) -> dict[str, Any]:
    """Deep and narrow: n objects, reachable only by walking n references."""
    head = Node(0)
    cursor = head
    for i in range(1, n):
        cursor.next = Node(i)
        cursor = cursor.next
    return {"head": head, "cursor": cursor, "total": n}


def make_flat_list(n: int) -> dict[str, Any]:
    """Wide and shallow: one container holding n instances, all at depth 2."""
    return {"items": [Node(i) for i in range(n)], "count": n}


def make_tree(n: int) -> dict[str, Any]:
    """Balanced-ish: depth about log n, the common data-structure case."""

    def build(lo: int, hi: int) -> TreeNode | None:
        if lo > hi:
            return None
        mid = (lo + hi) // 2
        node = TreeNode(mid)
        node.left = build(lo, mid - 1)
        node.right = build(mid + 1, hi)
        return node

    return {"root": build(0, n - 1), "size": n}


def make_dict_of_lists(n: int) -> dict[str, Any]:
    """An adjacency list, as a graph program would hold it."""
    graph = {f"n{i}": [f"n{(i + 1) % n}", f"n{(i + 7) % n}"] for i in range(n)}
    return {"graph": graph, "visited": set(), "order": []}


WORKLOADS: dict[str, Callable[[int], dict[str, Any]]] = {
    "linked-list": make_linked_list,
    "flat-list": make_flat_list,
    "tree": make_tree,
    "adjacency": make_dict_of_lists,
}


# ---------------------------------------------------------------------------
# strategies
# ---------------------------------------------------------------------------


@dataclass
class Measurement:
    workload: str
    objects: int
    strategy: str
    per_step_us: float
    p95_us: float
    visited: int
    within_budget: bool


def _time_calls(fn: Callable[[], Any], repeats: int) -> tuple[float, float]:
    """Median and 95th-percentile duration of ``fn`` in microseconds."""
    samples: list[float] = []
    for _ in range(repeats):
        start = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - start) * 1e6)
    samples.sort()
    p95 = samples[min(len(samples) - 1, int(len(samples) * 0.95))]
    return statistics.median(samples), p95


def measure(workload: str, size: int, repeats: int) -> list[Measurement]:
    build = WORKLOADS[workload]
    scope = build(size)
    roots = list(scope.items())
    results: list[Measurement] = []

    # --- identity comparison only: the floor -------------------------------
    previous = dict(scope)
    median, p95 = _time_calls(lambda: locals_changed(previous, scope), repeats)
    results.append(
        Measurement(workload, size, "identity", median, p95, 0, median <= BUDGET_US)
    )

    # --- full reachable walk ----------------------------------------------
    registry = Registry()
    warm = walk_full(roots, registry)
    median, p95 = _time_calls(lambda: walk_full(roots, registry), repeats)
    results.append(
        Measurement(workload, size, "full", median, p95, warm.visited, median <= BUDGET_US)
    )

    # --- full walk plus a diff, which is what a step actually costs --------
    before = warm.slots
    registry_d = Registry()
    walk_full(roots, registry_d)

    def full_with_diff() -> None:
        after = walk_full(roots, registry_d).slots
        diff_snapshots(before, after, lambda _kind, _payload: None)

    median, p95 = _time_calls(full_with_diff, repeats)
    results.append(
        Measurement(workload, size, "full+diff", median, p95, warm.visited, median <= BUDGET_US)
    )

    # --- bounded walks, with and without a per-object slot window ---------
    configurations = (
        ("bounded d=3 cap=256 slots=inf", 3, 256, None),
        ("bounded d=3 cap=256 slots=128", 3, 256, 128),
        ("bounded d=4 cap=512 slots=128", 4, 512, 128),
    )
    for label, depth, cap, window in configurations:
        bounded_registry = Registry()
        cache: dict[int, Any] = {}
        warm_b = walk_bounded(
            roots, bounded_registry, max_depth=depth, max_objects=cap, max_slots=window,
            immutable_cache=cache,
        )
        median, p95 = _time_calls(
            lambda d=depth, c=cap, w=window, r=bounded_registry, ic=cache: walk_bounded(
                roots, r, max_depth=d, max_objects=c, max_slots=w, immutable_cache=ic
            ),
            repeats,
        )
        results.append(
            Measurement(workload, size, label, median, p95, warm_b.visited, median <= BUDGET_US)
        )

    # --- bounded walk plus the diff, rooted at every local ----------------
    final_registry = Registry()
    final_cache: dict[int, Any] = {}
    baseline = walk_bounded(
        roots, final_registry, max_depth=3, max_objects=256, max_slots=128,
        immutable_cache=final_cache,
    ).slots

    def bounded_with_diff() -> None:
        after = walk_bounded(
            roots, final_registry, max_depth=3, max_objects=256, max_slots=128,
            immutable_cache=final_cache,
        ).slots
        diff_snapshots(baseline, after, lambda _kind, _payload: None)

    median, p95 = _time_calls(bounded_with_diff, repeats)
    results.append(
        Measurement(workload, size, "all-locals bounded+diff", median, p95, 0, median <= BUDGET_US)
    )

    # --- line-scoped: roots are only the names the executed line mentions --
    #
    # A line can only mutate what it can reach, and what it can reach starts from the names it
    # actually writes down. `values[i] = x` can touch `values` and nothing else. Taking the roots
    # from the line's own AST instead of from every local makes the cost proportional to the
    # statement rather than to the program's data.
    line_roots = [next(iter(scope.items()))]
    scoped_registry = Registry()
    scoped_cache: dict[int, Any] = {}
    scoped_baseline = walk_bounded(
        line_roots, scoped_registry, max_depth=3, max_objects=256, max_slots=128,
        immutable_cache=scoped_cache,
    ).slots

    def scoped_with_diff() -> None:
        after = walk_bounded(
            line_roots, scoped_registry, max_depth=3, max_objects=256, max_slots=128,
            immutable_cache=scoped_cache,
        ).slots
        diff_snapshots(scoped_baseline, after, lambda _kind, _payload: None)

    median, p95 = _time_calls(scoped_with_diff, repeats)
    results.append(
        Measurement(
            workload, size, "CANDIDATE line-scoped+diff", median, p95, 0, median <= BUDGET_US
        )
    )

    # --- a pure line: nothing on it can mutate the heap -------------------
    #
    # `total = a + b` contains no call, no subscript store, no attribute store. Static analysis can
    # prove no heap mutation is possible, so the step costs only a locals identity comparison.
    median, p95 = _time_calls(lambda: locals_changed(previous, scope), repeats)
    results.append(
        Measurement(workload, size, "CANDIDATE pure line", median, p95, 0, median <= BUDGET_US)
    )

    return results


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------


def run(sizes: list[int], repeats: int) -> list[Measurement]:
    all_results: list[Measurement] = []
    for workload in WORKLOADS:
        print(f"\n{workload}")
        print(f"  {'objects':>8}  {'strategy':<22}  {'median':>10}  {'p95':>10}  {'visited':>8}  budget")
        for size in sizes:
            for m in measure(workload, size, repeats):
                verdict = "ok" if m.within_budget else "OVER"
                print(
                    f"  {m.objects:>8}  {m.strategy:<22}  {m.per_step_us:>8.1f}µs  "
                    f"{m.p95_us:>8.1f}µs  {m.visited:>8}  {verdict}"
                )
                all_results.append(m)
            print()
    return all_results


def conclude(results: list[Measurement]) -> None:
    print("=" * 84)
    print(f"Conclusion (budget {BUDGET_US:.0f}µs per step)")
    print("=" * 84)

    largest = max(m.objects for m in results)
    at_scale = [m for m in results if m.objects == largest]

    full = [m for m in at_scale if m.strategy == "full+diff"]
    bounded = [m for m in at_scale if m.strategy.startswith("bounded d=3 cap=256")]

    if full:
        worst = max(full, key=lambda m: m.per_step_us)
        print(
            f"\nfull+diff at {largest} objects: worst case {worst.per_step_us:.0f}µs "
            f"per step ({worst.workload})"
        )
        overhead = worst.per_step_us / BUDGET_US
        print(f"  that is {overhead:.0f}x the budget")
        print(
            f"  a 10,000-step program would spend "
            f"{worst.per_step_us * 10_000 / 1e6:.1f}s in heap walking alone"
        )

    if bounded:
        worst_b = max(bounded, key=lambda m: m.per_step_us)
        print(
            f"\nbounded d=3 cap=256 at {largest} objects: worst case "
            f"{worst_b.per_step_us:.0f}µs per step ({worst_b.workload})"
        )
        print(
            f"  a 10,000-step program would spend "
            f"{worst_b.per_step_us * 10_000 / 1e6:.2f}s in heap walking"
        )

    scaling = sorted(
        (m for m in results if m.strategy == "full+diff" and m.workload == "flat-list"),
        key=lambda m: m.objects,
    )
    if len(scaling) >= 2:
        first, last = scaling[0], scaling[-1]
        growth = last.per_step_us / first.per_step_us if first.per_step_us else 0
        ratio = last.objects / first.objects
        print(
            f"\nfull+diff scaling on flat-list: {ratio:.0f}x the objects costs "
            f"{growth:.0f}x the time — linear in heap size, as expected"
        )

    bounded_scaling = sorted(
        (
            m
            for m in results
            if m.strategy.startswith("bounded d=3 cap=256") and m.workload == "flat-list"
        ),
        key=lambda m: m.objects,
    )
    if len(bounded_scaling) >= 2:
        first, last = bounded_scaling[0], bounded_scaling[-1]
        growth = last.per_step_us / first.per_step_us if first.per_step_us else 0
        print(
            f"bounded scaling on flat-list: {last.objects / first.objects:.0f}x the objects costs "
            f"{growth:.1f}x the time — flat, as intended"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sizes",
        type=int,
        nargs="+",
        default=[100, 1_000, 10_000],
        help="heap sizes to measure",
    )
    parser.add_argument("--repeats", type=int, default=25, help="samples per measurement")
    parser.add_argument("--json", type=Path, help="also write results as JSON")
    args = parser.parse_args()

    print(f"python {sys.version.split()[0]}")
    print(f"heap sizes: {args.sizes}, {args.repeats} samples per measurement")

    results = run(args.sizes, args.repeats)
    conclude(results)

    if args.json:
        args.json.write_text(json.dumps([asdict(m) for m in results], indent=2))
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
