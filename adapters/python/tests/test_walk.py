"""Correctness of the heap walker.

The benchmark settled how *fast* the walk is. These assert it is *right*, which matters more: a fast
walk that misreports aliasing or loses a mutation produces a visualization that teaches the user
something false.

The cases that carry real weight here are aliasing, cycles, and truncation. Aliasing and cycles are
what the reference-based value model exists to represent, and truncation is where the tool is most
tempted to quietly present partial data as complete.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flow_view_tracer.walk import (  # noqa: E402
    Registry,
    classify,
    diff_snapshots,
    is_atomic,
    locals_changed,
    walk_bounded,
    walk_full,
)


class Node:
    __slots__ = ("value", "next")

    def __init__(self, value: int) -> None:
        self.value = value
        self.next: Node | None = None


class Plain:
    def __init__(self, **kwargs: object) -> None:
        self.__dict__.update(kwargs)


def collect(events: list[tuple[str, dict]]) -> dict:
    return {kind: [payload for k, payload in events if k == kind] for kind, _ in events}


# ---------------------------------------------------------------------------


class TestClassification:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ([], "list"),
            ((), "tuple"),
            ({}, "map"),
            (set(), "set"),
            (bytearray(), "bytes"),
            (ValueError("x"), "exception"),
            (Node(1), "instance"),
            (Plain(), "instance"),
            (Node, "class"),
        ],
    )
    def test_maps_python_types_to_schema_kinds(self, value: object, expected: str) -> None:
        assert classify(value) == expected

    @pytest.mark.parametrize("value", [None, True, 3, 3.5, "s", b"b", 2j])
    def test_atomics_are_inline(self, value: object) -> None:
        assert is_atomic(value)

    @pytest.mark.parametrize("value", [[], {}, set(), Node(1)])
    def test_containers_are_not_inline(self, value: object) -> None:
        assert not is_atomic(value)


class TestIdentity:
    def test_the_same_object_keeps_one_id(self) -> None:
        registry = Registry()
        node = Node(1)
        assert registry.id_for(node) == registry.id_for(node)

    def test_equal_but_distinct_objects_get_different_ids(self) -> None:
        # Equality is irrelevant; the heap view is about identity. Two equal lists are two objects.
        registry = Registry()
        assert registry.id_for([1, 2]) != registry.id_for([1, 2])

    def test_registered_objects_are_kept_alive(self) -> None:
        # id() is only unique among live objects, so an id could otherwise be recycled onto a
        # different object and silently repoint part of the trace.
        registry = Registry()
        first = registry.id_for(Node(1))
        # The node is unreferenced by the test now; only the registry holds it.
        second = registry.id_for(Node(2))
        assert first != second


class TestAliasing:
    def test_two_roots_to_one_object_report_the_same_id(self) -> None:
        shared = [1, 2, 3]
        registry = Registry()
        result = walk_full([("first", shared), ("second", shared)], registry)
        # One object, reached twice.
        assert len(result.discovered) == 1
        assert result.visited == 1

    def test_a_nested_alias_is_one_object(self) -> None:
        shared = [1]
        scope = {"a": {"x": shared}, "b": {"y": shared}}
        registry = Registry()
        result = walk_full(list(scope.items()), registry)
        refs = [
            value[1]
            for slots in result.slots.values()
            for value in slots.values()
            if value[0] == "ref"
        ]
        # Both dicts hold a reference, and both must be the same id.
        assert len(refs) == 2
        assert refs[0] == refs[1]


class TestCycles:
    def test_a_self_reference_terminates(self) -> None:
        node = Node(1)
        node.next = node
        registry = Registry()
        result = walk_full([("node", node)], registry)
        assert result.visited == 1
        obj_id = next(iter(result.slots))
        assert result.slots[obj_id]["next"] == ("ref", obj_id)

    def test_a_ring_terminates_and_is_fully_reported(self) -> None:
        a, b, c = Node(1), Node(2), Node(3)
        a.next, b.next, c.next = b, c, a
        registry = Registry()
        result = walk_full([("a", a)], registry)
        assert result.visited == 3

    def test_a_mutually_referencing_pair_terminates(self) -> None:
        left = Plain()
        right = Plain(peer=left)
        left.peer = right
        registry = Registry()
        assert walk_full([("left", left)], registry).visited == 2


class TestOpaqueTypes:
    def test_modules_and_functions_are_not_followed(self) -> None:
        # A program that imports math should not have the module's contents in its heap view.
        import math

        registry = Registry()
        result = walk_full([("math", math), ("fn", len)], registry)
        assert result.visited == 0

    def test_an_opaque_value_inside_a_container_is_summarised(self) -> None:
        registry = Registry()
        result = walk_full([("holder", [len])], registry)
        slots = next(iter(result.slots.values()))
        kind, rendered = slots["0"]
        assert kind == "prim"
        assert "builtin_function" in str(rendered)


class TestSlots:
    def test_reads_slots_declared_on_a_base_class(self) -> None:
        class Base:
            __slots__ = ("a",)

        class Derived(Base):
            __slots__ = ("b",)

        obj = Derived()
        obj.a, obj.b = 1, 2
        registry = Registry()
        slots = next(iter(walk_full([("o", obj)], registry).slots.values()))
        assert slots == {"a": ("prim", 1), "b": ("prim", 2)}

    def test_an_unassigned_slot_is_omitted_not_invented(self) -> None:
        class Partial:
            __slots__ = ("set_one", "never_set")

        obj = Partial()
        obj.set_one = 1
        registry = Registry()
        slots = next(iter(walk_full([("o", obj)], registry).slots.values()))
        assert "set_one" in slots
        assert "never_set" not in slots


class TestBounds:
    def test_depth_limits_how_far_the_walk_descends(self) -> None:
        head = Node(0)
        cursor = head
        for i in range(1, 10):
            cursor.next = Node(i)
            cursor = cursor.next

        registry = Registry()
        result = walk_bounded([("head", head)], registry, max_depth=2, max_slots=None)
        assert result.visited == 3
        assert result.truncated

    def test_beyond_the_frontier_the_reference_still_exists(self) -> None:
        # Nothing may disappear from the graph just because it was not expanded.
        head = Node(0)
        head.next = Node(1)
        registry = Registry()
        result = walk_bounded([("head", head)], registry, max_depth=0, max_slots=None)
        slots = next(iter(result.slots.values()))
        assert slots["next"][0] == "ref"

    def test_the_object_ceiling_stops_the_walk_and_says_so(self) -> None:
        registry = Registry()
        result = walk_bounded(
            [("items", [Node(i) for i in range(50)])],
            registry,
            max_objects=10,
            max_slots=None,
        )
        assert result.visited == 10
        assert result.truncated

    def test_a_large_container_is_windowed_at_both_ends(self) -> None:
        # The window keeps the tail, because a program appending to a list does its interesting work
        # there and a prefix-only view would show a frozen head.
        registry = Registry()
        values = list(range(100))
        result = walk_bounded([("values", values)], registry, max_slots=20)
        slots = next(iter(result.slots.values()))
        assert len(slots) == 20
        assert "0" in slots
        assert "99" in slots
        assert result.truncated

    def test_a_container_inside_the_window_is_not_marked_truncated(self) -> None:
        registry = Registry()
        result = walk_bounded([("values", [1, 2, 3])], registry, max_slots=20)
        assert not result.truncated

    def test_cost_does_not_grow_with_heap_size(self) -> None:
        # The property the whole strategy exists for. Ten times the data, same work.
        small = [Node(i) for i in range(100)]
        large = [Node(i) for i in range(1000)]
        a = walk_bounded([("items", small)], Registry())
        b = walk_bounded([("items", large)], Registry())
        assert a.visited == b.visited


class TestImmutableCache:
    def test_a_tuple_is_read_once(self) -> None:
        registry = Registry()
        cache: dict[int, dict] = {}
        data = (1, 2, 3)
        walk_bounded([("t", data)], registry, immutable_cache=cache)
        assert len(cache) == 1

        # A second walk must reuse the cached read and still produce the same slots.
        second = walk_bounded([("t", data)], registry, immutable_cache=cache)
        obj_id = registry.id_for(data)
        assert second.slots[obj_id] == {"0": ("prim", 1), "1": ("prim", 2), "2": ("prim", 3)}

    def test_a_mutable_object_inside_a_tuple_is_still_followed(self) -> None:
        # `(some_list,)` never changes while some_list changes freely, so caching the tuple must not
        # stop its children being walked.
        inner: list[int] = [1]
        holder = (inner,)
        registry = Registry()
        cache: dict[int, dict] = {}

        walk_bounded([("h", holder)], registry, immutable_cache=cache)
        inner.append(2)
        second = walk_bounded([("h", holder)], registry, immutable_cache=cache)

        inner_id = registry.id_for(inner)
        assert inner_id in second.slots
        assert second.slots[inner_id] == {"0": ("prim", 1), "1": ("prim", 2)}

    def test_a_list_is_never_cached(self) -> None:
        registry = Registry()
        cache: dict[int, dict] = {}
        walk_bounded([("l", [1, 2])], registry, immutable_cache=cache)
        assert cache == {}


class TestDiffing:
    def test_an_element_assignment_is_reported_with_its_previous_value(self) -> None:
        registry = Registry()
        values = [1, 2, 3]
        before = walk_full([("v", values)], registry).slots
        values[1] = 99
        after = walk_full([("v", values)], registry).slots

        events: list[tuple[str, dict]] = []
        diff_snapshots(before, after, lambda kind, payload: events.append((kind, payload)))

        assert len(events) == 1
        _, payload = events[0]
        assert payload["key"] == "1"
        assert payload["value"] == ("prim", 99)
        assert payload["prev"] == ("prim", 2)
        assert payload["op"] == "set"

    def test_an_append_is_reported_as_an_append(self) -> None:
        registry = Registry()
        values = [1]
        before = walk_full([("v", values)], registry).slots
        values.append(2)
        after = walk_full([("v", values)], registry).slots

        events: list[tuple[str, dict]] = []
        diff_snapshots(before, after, lambda kind, payload: events.append((kind, payload)))
        assert [p["op"] for _, p in events] == ["append"]

    def test_a_removal_is_reported_as_a_delete(self) -> None:
        registry = Registry()
        mapping = {"a": 1, "b": 2}
        before = walk_full([("m", mapping)], registry).slots
        del mapping["b"]
        after = walk_full([("m", mapping)], registry).slots

        events: list[tuple[str, dict]] = []
        diff_snapshots(before, after, lambda kind, payload: events.append((kind, payload)))
        assert [p["op"] for _, p in events] == ["delete"]
        assert events[0][1]["prev"] == ("prim", 2)

    def test_an_unchanged_heap_produces_nothing(self) -> None:
        registry = Registry()
        values = [1, 2, 3]
        before = walk_full([("v", values)], registry).slots
        after = walk_full([("v", values)], registry).slots
        events: list[tuple[str, dict]] = []
        diff_snapshots(before, after, lambda kind, payload: events.append((kind, payload)))
        assert events == []

    def test_a_mutation_through_an_alias_is_reported_once(self) -> None:
        registry = Registry()
        shared = [1]
        roots = [("first", shared), ("second", shared)]
        before = walk_full(roots, registry).slots
        shared.append(2)
        after = walk_full(roots, registry).slots

        events: list[tuple[str, dict]] = []
        diff_snapshots(before, after, lambda kind, payload: events.append((kind, payload)))
        # One object changed, so one event - not one per name pointing at it.
        assert len(events) == 1

    def test_an_object_leaving_the_walked_region_is_not_reported_as_destroyed(self) -> None:
        # Falling outside the window is not deallocation, and saying otherwise would put a lie in
        # the trace.
        registry = Registry()
        values = [1, 2]
        before = walk_full([("v", values)], registry).slots
        events: list[tuple[str, dict]] = []
        diff_snapshots(before, {}, lambda kind, payload: events.append((kind, payload)))
        assert events == []


class TestLocalsComparison:
    def test_detects_a_rebinding(self) -> None:
        assert locals_changed({"x": 1}, {"x": 2})

    def test_detects_a_new_name(self) -> None:
        assert locals_changed({}, {"x": 1})

    def test_detects_a_removed_name(self) -> None:
        assert locals_changed({"x": 1}, {})

    def test_ignores_an_unchanged_binding(self) -> None:
        values: list[int] = []
        assert not locals_changed({"x": values}, {"x": values})

    def test_does_not_see_in_place_mutation(self) -> None:
        # Documented limitation, and the reason this is only a fast pre-filter: a line that mutates
        # in place still needs the walk.
        values = [1]
        before = {"x": values}
        values.append(2)
        assert not locals_changed(before, {"x": values})
