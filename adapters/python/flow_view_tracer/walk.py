"""Reading the Python heap.

The tracer has to answer one question after every line: *what changed?* Python offers no write
barrier, so there is no notification when a list gains an element — the only way to know is to look.

How much looking is the central performance question of this adapter, and this module exists to make
the alternatives measurable rather than arguable:

``walk_full``
    Every object reachable from the roots. Complete, and costs O(reachable) per line.

``walk_bounded``
    Reachable within a few references of the roots, with a ceiling on how many objects are visited.
    Bounded per line regardless of heap size, at the cost of not seeing deep structure until it comes
    closer to a local variable.

``diff_snapshots``
    Turns two walks into the mutation events the trace carries.

Zero dependencies outside the standard library, because the identical module has to run inside
Pyodide for the Lite profile.
"""

from __future__ import annotations

import types
from typing import Any, Callable, Iterable, Iterator, Mapping, NamedTuple

__all__ = [
    "Registry",
    "Slots",
    "Snapshot",
    "WalkResult",
    "classify",
    "diff_snapshots",
    "is_atomic",
    "walk_bounded",
    "walk_full",
]

# ---------------------------------------------------------------------------
# what counts as a value
# ---------------------------------------------------------------------------

#: Types carried inline in a trace rather than as heap objects.
ATOMIC = (type(None), bool, int, float, complex, str, bytes)

#: Types that exist in every program and would bury the user's own data. A traced function that
#: touches ``math`` should not drag the module's contents into the heap view.
_OPAQUE_TYPES = (
    types.ModuleType,
    types.FunctionType,
    types.BuiltinFunctionType,
    types.MethodType,
    types.CodeType,
    types.FrameType,
    types.TracebackType,
    types.GeneratorType,
    type,
)

_SEQUENCES = (list, tuple)
_SETS = (set, frozenset)


#: Exact-type lookup for the atomic check. A set membership test on ``type(obj)`` is several times
#: faster than ``isinstance`` against a tuple, and this runs once per slot of every object read after
#: every executed line — the hottest path in the adapter.
_ATOMIC_SET = frozenset(ATOMIC)


def is_atomic(obj: object) -> bool:
    """True when a value belongs inline in the trace instead of on the heap."""
    return isinstance(obj, ATOMIC)


def classify(obj: object) -> str:
    """Map a Python object to a schema ``ObjKind``."""
    if isinstance(obj, list):
        return "list"
    if isinstance(obj, tuple):
        return "tuple"
    if isinstance(obj, dict):
        return "map"
    if isinstance(obj, (set, frozenset)):
        return "set"
    if isinstance(obj, bytearray):
        return "bytes"
    if isinstance(obj, BaseException):
        return "exception"
    if isinstance(obj, types.ModuleType):
        return "module"
    if isinstance(obj, type):
        return "class"
    if isinstance(obj, (types.FunctionType, types.MethodType, types.BuiltinFunctionType)):
        return "function"
    if isinstance(obj, types.GeneratorType):
        return "generator"
    if hasattr(obj, "__dict__") or hasattr(obj, "__slots__"):
        return "instance"
    return "opaque"


# ---------------------------------------------------------------------------
# identity
# ---------------------------------------------------------------------------


class Registry:
    """Stable trace ids for live objects.

    Keyed on :func:`id`, which is only unique among *live* objects — CPython reuses addresses. A
    strong reference is therefore held for every registered object, so an id can never be recycled
    while the trace still refers to it.

    That deliberately extends the lifetime of objects the traced program has dropped. The trade is
    accepted: a visualizer whose object ids silently start pointing at different objects is worse
    than one that uses more memory. The step budget bounds how far it can go.

    The cost is larger than memory, and saying "memory" here was underselling it. Holding a reference
    means the program's own ``__del__`` does not run when the program says it does. Measured on
    ``n = Noisy(); del n; print("after")``:

        plain python   gone / after the del
        flow_view      after the del

    The finalizer runs at interpreter shutdown instead, outside the traced region, so its output is
    missing from the trace rather than merely late. A reader would conclude ``__del__`` never ran.

    Not silently accepted: the adapter finds ``__del__`` definitions in the source and warns for each
    one. A proper fix means weak references where the type allows them (user classes do; ``list`` and
    ``dict`` do not) plus ``obj_free`` events emitted from the death callback, and emitting trace
    events from a weakref callback that can fire anywhere is its own hazard. Recorded rather than
    attempted in passing — see docs/decisions/0005-object-identity-and-finalizers.md.
    """

    __slots__ = ("_ids", "_keep", "_next", "_on_new")

    def __init__(self, on_new: Callable[[int, object], None] | None = None) -> None:
        self._ids: dict[int, int] = {}
        self._keep: dict[int, object] = {}
        self._next = 1
        # Fires exactly once per object, the moment it is first given an id.
        #
        # This is a single choke point on purpose. Ids are handed out from several places — the walk
        # visiting an object, the walk merely *referencing* one beyond its depth limit, the tracer
        # encoding a variable's value — and an id that reaches the trace without the object being
        # announced produces a trace that mutates something it never introduced. Announcing here
        # makes that impossible rather than merely discouraged.
        self._on_new = on_new

    def id_for(self, obj: object) -> int:
        key = id(obj)
        existing = self._ids.get(key)
        if existing is not None:
            return existing
        assigned = self._next
        self._next += 1
        self._ids[key] = assigned
        self._keep[key] = obj
        if self._on_new is not None:
            self._on_new(assigned, obj)
        return assigned

    def known(self, obj: object) -> bool:
        return id(obj) in self._ids

    def __len__(self) -> int:
        return len(self._ids)


# A slot value as the trace carries it: ("prim", value) or ("ref", obj_id).
Value = tuple[str, Any]

#: Slot key to value for one object.
Slots = dict[str, Value]

#: Object id to its slots.
Snapshot = dict[int, Slots]


class ObjectInfo(NamedTuple):
    """What a newly seen object needs in order to be announced."""

    obj_id: int
    kind: str
    type_name: str
    length: int | None


class WalkResult(NamedTuple):
    slots: Snapshot
    #: Objects seen for the first time during this walk.
    discovered: list[ObjectInfo]
    #: True when a ceiling stopped the walk early, so the caller can say so rather than pretend.
    truncated: bool
    visited: int


# ---------------------------------------------------------------------------
# reading one object
# ---------------------------------------------------------------------------


def _instance_items(obj: object) -> Iterator[tuple[str, Any]]:
    d = getattr(obj, "__dict__", None)
    if type(d) is dict:
        yield from d.items()
        return
    # ``__slots__`` classes have no instance dict. Walking the MRO catches slots declared by base
    # classes, which a single ``type(obj).__slots__`` lookup would miss.
    for klass in type(obj).__mro__:
        for name in klass.__dict__.get("__slots__", ()) or ():
            if type(name) is str:
                try:
                    yield name, getattr(obj, name)
                except AttributeError:
                    # Declared but never assigned. Absent is the truth here, so it is omitted
                    # rather than reported as None.
                    continue


def _windowed_indices(length: int, limit: int) -> tuple[range, range]:
    """Head and tail index ranges to read from a sequence of ``length``.

    Reading the two ends rather than a prefix is deliberate: a program appending to a list has its
    interesting work at the end, and a prefix-only window would show a frozen head while the action
    happened somewhere invisible.
    """
    if length <= limit:
        return range(length), range(0)
    tail = max(1, limit // 4)
    head = limit - tail
    return range(head), range(length - tail, length)


def _items(obj: object, max_slots: int | None = None) -> Iterator[tuple[str, Any]]:
    """Slot key/value pairs for a container or instance.

    Keys are strings because the trace uses string slot keys; positions become decimal strings.

    ``max_slots`` caps how many entries are read from one object. This is what bounds the cost of a
    single enormous container: capping object count and depth does nothing for a list of ten
    thousand elements, which is one object at depth one and ten thousand reads.
    """
    if isinstance(obj, (list, tuple, bytearray)):
        length = len(obj)
        if max_slots is None or length <= max_slots:
            for index, item in enumerate(obj):
                yield str(index), item
            return
        head, tail = _windowed_indices(length, max_slots)
        for index in head:
            yield str(index), obj[index]
        for index in tail:
            yield str(index), obj[index]
        return

    if isinstance(obj, dict):
        count = 0
        for key, item in obj.items():
            if max_slots is not None and count >= max_slots:
                return
            count += 1
            yield (key if isinstance(key, str) else repr(key)), item
        return

    if isinstance(obj, _SETS):
        # Sets are unordered, so a stable key keeps diffs meaningful instead of reporting every
        # element as changed because iteration order moved. Sorting costs O(n log n), so it is only
        # worth it for a set small enough to show whole; a large one is truncated anyway.
        if max_slots is not None and len(obj) > max_slots:
            for count, item in enumerate(obj):
                if count >= max_slots:
                    return
                yield repr(item), item
            return
        for item in sorted(obj, key=repr):
            yield repr(item), item
        return

    yield from _instance_items(obj)


def _length_of(obj: object) -> int | None:
    if isinstance(obj, (list, tuple, dict, set, frozenset, bytearray)):
        return len(obj)
    return None


def _type_name(obj: object) -> str:
    return type(obj).__name__


# ---------------------------------------------------------------------------
# walking
# ---------------------------------------------------------------------------


def _should_follow(obj: object, follow_opaque: bool) -> bool:
    if is_atomic(obj):
        return False
    if not follow_opaque and isinstance(obj, _OPAQUE_TYPES):
        return False
    return True


#: Types whose contents cannot change once created, so re-reading them every step is wasted work.
_IMMUTABLE = (tuple, frozenset, str, bytes)


def _walk(
    roots: Iterable[tuple[str, Any]],
    registry: Registry,
    *,
    max_depth: int | None,
    max_objects: int | None,
    max_slots: int | None,
    follow_opaque: bool,
    immutable_cache: dict[int, Slots] | None = None,
) -> WalkResult:
    slots: Snapshot = {}
    discovered: list[ObjectInfo] = []
    truncated = False
    visited = 0

    # Breadth-first so a ceiling truncates the parts furthest from the user's variables, which are
    # the parts they are least likely to be looking at.
    queue: list[tuple[object, int]] = []
    seen: set[int] = set()

    for _, value in roots:
        if _should_follow(value, follow_opaque) and id(value) not in seen:
            seen.add(id(value))
            queue.append((value, 0))

    head = 0
    while head < len(queue):
        obj, depth = queue[head]
        head += 1

        if max_objects is not None and visited >= max_objects:
            truncated = True
            break

        known = registry.known(obj)
        obj_id = registry.id_for(obj)
        if not known:
            discovered.append(
                ObjectInfo(obj_id, classify(obj), _type_name(obj), _length_of(obj))
            )

        visited += 1

        # A tuple read once is a tuple read forever. But an immutable container can still *hold*
        # mutable objects — `(some_list,)` never changes while `some_list` changes freely — so the
        # children must still be enqueued. Only the slot read itself is skipped.
        cached = immutable_cache.get(obj_id) if immutable_cache is not None else None
        if cached is not None:
            slots[obj_id] = cached
            if max_depth is None or depth < max_depth:
                for key, item in _items(obj, max_slots):
                    if is_atomic(item) or not _should_follow(item, follow_opaque):
                        continue
                    if id(item) not in seen:
                        seen.add(id(item))
                        queue.append((item, depth + 1))
            continue

        entry: Slots = {}
        slots[obj_id] = entry

        descend = max_depth is None or depth < max_depth
        # Hoisted out of the loop: these are looked up once per object rather than once per slot,
        # which measurably matters when this runs after every executed line.
        id_for = registry.id_for
        ids = registry._ids  # noqa: SLF001 - hot path, deliberate
        append = queue.append
        add_seen = seen.add

        for key, item in _items(obj, max_slots):
            item_type = type(item)
            if item_type in _ATOMIC_SET:
                entry[key] = ("prim", item)
                continue
            if not _should_follow(item, follow_opaque):
                entry[key] = ("prim", f"<{item_type.__name__}>")
                continue
            item_key = id(item)
            existing = ids.get(item_key)
            entry[key] = ("ref", existing if existing is not None else id_for(item))
            if descend:
                if item_key not in seen:
                    add_seen(item_key)
                    append((item, depth + 1))
            else:
                # The reference is reported; its contents wait until it comes within reach.
                truncated = True

        if max_slots is not None:
            length = _length_of(obj)
            if length is not None and length > max_slots:
                truncated = True

        if immutable_cache is not None and isinstance(obj, _IMMUTABLE):
            immutable_cache[obj_id] = entry

    return WalkResult(slots, discovered, truncated, visited)


def walk_full(
    roots: Iterable[tuple[str, Any]],
    registry: Registry,
    *,
    follow_opaque: bool = False,
    immutable_cache: dict[int, Slots] | None = None,
) -> WalkResult:
    """Every object reachable from the roots, in full.

    Complete and O(reachable) per call, which measurement shows is only affordable for small heaps.
    Offered as an explicit "show me everything" mode rather than as the default.
    """
    return _walk(
        roots,
        registry,
        max_depth=None,
        max_objects=None,
        max_slots=None,
        follow_opaque=follow_opaque,
        immutable_cache=immutable_cache,
    )


#: Default ceilings, chosen by measurement rather than by taste.
#:
#: At depth 3, 128 objects and a 32-slot window, per-step cost on a 10,000-object heap measured
#: 9.6µs for a linked list, 39µs for a balanced tree, 74µs for one huge flat list and 63µs for an
#: adjacency map — and crucially, all four are independent of heap size. Widening the slot window to
#: 64 doubles the cost for no benefit a reader would notice, since nobody reads 64 elements of one
#: container at a glance. See docs/decisions/0001-reading-the-python-heap.md.
DEFAULT_MAX_DEPTH = 3
DEFAULT_MAX_OBJECTS = 128
DEFAULT_MAX_SLOTS = 32


def walk_bounded(
    roots: Iterable[tuple[str, Any]],
    registry: Registry,
    *,
    max_depth: int = DEFAULT_MAX_DEPTH,
    max_objects: int = DEFAULT_MAX_OBJECTS,
    max_slots: int | None = DEFAULT_MAX_SLOTS,
    follow_opaque: bool = False,
    immutable_cache: dict[int, Slots] | None = None,
) -> WalkResult:
    """Objects near the roots, under three independent ceilings.

    All three are needed, and measurement is what showed it. Capping depth and object count still
    left a ten-thousand-element list costing ten thousand reads — one object, at depth one. Only a
    per-object slot window bounds that.

    Structure beyond a frontier is still *referenced*, so nothing vanishes from the graph; contents
    fill in when a variable brings them closer. Whenever a ceiling bites, ``truncated`` is set so
    the caller can say so in the trace rather than present a partial heap as complete.
    """
    return _walk(
        roots,
        registry,
        max_depth=max_depth,
        max_objects=max_objects,
        max_slots=max_slots,
        follow_opaque=follow_opaque,
        immutable_cache=immutable_cache,
    )


# ---------------------------------------------------------------------------
# diffing
# ---------------------------------------------------------------------------


def diff_snapshots(
    before: Snapshot,
    after: Snapshot,
    emit: Callable[[str, dict[str, Any]], None],
) -> None:
    """Report the mutations between two walks.

    Only objects present in both are compared. One that has left ``after`` has merely fallen out of
    the walked region — it has not been destroyed, and claiming otherwise would put a lie in the
    trace.
    """
    for obj_id, new_slots in after.items():
        old_slots = before.get(obj_id)
        if old_slots is None:
            # First sight of the object. Its whole contents are the change.
            for key, value in new_slots.items():
                emit("obj_set", {"obj": obj_id, "key": key, "value": value, "op": "set"})
            continue
        if old_slots == new_slots:
            continue

        for key, value in new_slots.items():
            previous = old_slots.get(key)
            if previous is None:
                emit(
                    "obj_set",
                    {"obj": obj_id, "key": key, "value": value, "op": "append"},
                )
            elif previous != value:
                emit(
                    "obj_set",
                    {"obj": obj_id, "key": key, "value": value, "prev": previous, "op": "set"},
                )

        removed = [key for key in old_slots if key not in new_slots]
        if removed:
            for key in removed:
                emit(
                    "obj_set",
                    {
                        "obj": obj_id,
                        "key": key,
                        "value": ("prim", None),
                        "prev": old_slots[key],
                        "op": "delete",
                    },
                )


def locals_changed(before: Mapping[str, Any], after: Mapping[str, Any]) -> bool:
    """Cheap test for whether a frame's bindings moved at all.

    Compares by identity, which is the floor on per-step cost: if nothing here changed, the
    expensive walk may still be needed for in-place mutation, but many steps can be recognised as
    uninteresting for a fraction of the price.
    """
    if len(before) != len(after):
        return True
    for name, value in after.items():
        if name not in before or before[name] is not value:
            return True
    return False
