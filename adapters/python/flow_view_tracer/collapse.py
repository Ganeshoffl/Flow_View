"""Folding the middle of a long loop, in flight.

A million-iteration loop produces tens of millions of events. Nobody wants to look at them and no
browser wants to hold them, but the last thing the loop did still has to be exact — you cannot show
someone a summary and then be unable to tell them what `total` ended up as.

So the middle is folded into a single **composite invertible step**. A ``collapse`` event carries the
net before and after value of every slot the folded span touched, which is what lets the TraceStore
step *backward* across a fold without the events that made it up. Mutations carry ``prev``, so the net
effect of a span is simply: the first write's ``prev``, and the last write's ``value``.

Three properties this has to keep, in order of how badly they hurt when broken:

1. **Nothing is lost.** Program output, questions asked, exceptions raised and objects created are
   visible behaviour. A fold that swallowed them would make the trace a lie, so a span containing
   anything this cannot represent is not folded at all — see ``FOLDABLE``.
2. **State is exact.** Replaying a collapsed trace must leave exactly the state an uncollapsed one
   would. That is a property worth testing directly, and ``test_collapse.py`` does.
3. **It streams, with bounded memory.** Waiting for the loop to finish before emitting anything would
   defeat the point. Buffering is bounded by the tail window plus one chunk.

The shape of the output, for a loop of 1000 with a head and tail of 3:

    iterations 0,1,2      verbatim
    iterations 3..996     one or more collapse events, emitted as the loop runs
    iterations 997,998,999 verbatim

The tail is the reason anything is buffered at all: you cannot know an iteration is one of the last
three until the loop ends, so the most recent three are held and folded only once a fourth arrives.
"""

from __future__ import annotations

from typing import Any, Callable, Iterator

Event = tuple[str, dict[str, Any]]

#: Events a fold can represent, and therefore swallow.
#:
#: ``var_set`` and ``obj_set`` become CollapseEffects. ``metric`` deltas are summed onto the collapse
#: event. ``step_line``, ``branch``, ``jump``, ``loop_iter`` and balanced ``frame_push``/``frame_pop``
#: pairs describe *how* the span got there, which is precisely what folding discards.
FOLDABLE = frozenset(
    {
        "step_line",
        "branch",
        "jump",
        "loop_iter",
        "var_set",
        "var_del",
        "obj_set",
        "obj_resize",
        "metric",
        "frame_push",
        "frame_pop",
    }
)

#: How many iterations to keep in full at each end of a loop.
DEFAULT_KEEP_HEAD = 3
DEFAULT_KEEP_TAIL = 3

#: Iterations folded into one collapse event before it is emitted and a new one started.
#:
#: This is what keeps the trace streaming. Without it a long loop would emit nothing between its head
#: and its tail, and the effect accumulator would grow with the number of distinct slots touched
#: rather than being flushed periodically.
DEFAULT_CHUNK = 2000

#: Iterations a loop must exceed before folding starts.
#:
#: Below this the fold costs more than it saves: a collapse event carrying two effects is larger than
#: the handful of events it replaces, and a reader would rather see six iterations than four and a
#: summary.
DEFAULT_MIN_ITERATIONS = 20


class _Fold:
    """The net effect of a run of iterations, accumulated as they go by."""

    __slots__ = ("region", "iterations", "first_iter", "last_iter", "effects", "metrics", "from_seq")

    def __init__(self, region: int, from_seq: int) -> None:
        self.region = region
        self.from_seq = from_seq
        self.iterations = 0
        self.first_iter: int | None = None
        self.last_iter: int | None = None
        # Keyed by the slot a write lands on. Insertion order is preserved, which keeps the emitted
        # effects in the order the span first touched them and so keeps traces comparable.
        self.effects: dict[tuple[Any, ...], dict[str, Any]] = {}
        self.metrics: dict[str, int] = {}

    @property
    def empty(self) -> bool:
        return self.iterations == 0

    def absorb(self, kind: str, payload: dict[str, Any]) -> None:
        if kind == "loop_iter":
            self.iterations += 1
            index = payload.get("i")
            if self.first_iter is None:
                self.first_iter = index
            self.last_iter = index
            return

        if kind == "metric":
            name = payload["name"]
            self.metrics[name] = self.metrics.get(name, 0) + int(payload.get("delta", 1))
            return

        if kind == "var_set":
            self._write(("var", payload.get("frame"), payload["name"]), payload)
            return

        if kind == "var_del":
            # A deletion is a write to nothing. `after` absent is how the store reads "gone".
            self._write(("var", payload.get("frame"), payload["name"]), payload, deleted=True)
            return

        if kind == "obj_set":
            self._write(("obj", payload["obj"], str(payload["key"])), payload)
            return

        # step_line, branch, jump, frame_push, frame_pop: how the span got here, which is what folding
        # is for. Nothing to record.

    def _write(
        self, slot: tuple[Any, ...], payload: dict[str, Any], *, deleted: bool = False
    ) -> None:
        existing = self.effects.get(slot)
        if existing is None:
            effect: dict[str, Any] = {"kind": slot[0], "key": slot[2]}
            if slot[0] == "var":
                if slot[1] is not None:
                    effect["frame"] = slot[1]
            else:
                effect["obj"] = slot[1]
            # The first write's `prev` is where the span started. Absent `prev` means the slot did not
            # exist, which is itself the correct `before` - the store reads a missing `before` as
            # "remove this again" when stepping backward.
            if "prev" in payload:
                effect["before"] = payload["prev"]
            self.effects[slot] = effect
            existing = effect

        # The last write wins for `after`, which is the whole idea of a net effect.
        if deleted:
            existing.pop("after", None)
        else:
            existing["after"] = payload["value"]

    def to_event(self, to_seq: int) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "region": self.region,
            "from_seq": self.from_seq,
            "to_seq": to_seq,
            "iterations": self.iterations,
            "effects": list(self.effects.values()),
        }
        if self.first_iter is not None:
            payload["from_iter"] = self.first_iter
        if self.last_iter is not None:
            payload["to_iter"] = self.last_iter
        if self.metrics:
            payload["metrics"] = dict(self.metrics)
        return payload


class _Region:
    """One loop being watched."""

    __slots__ = ("region", "seen", "tail", "current", "fold", "giving_up", "depth")

    def __init__(self, region: int) -> None:
        self.region = region
        self.seen = 0
        # Completed iterations held back, newest last. Each is a list of its events.
        self.tail: list[list[Event]] = []
        # The iteration currently being collected, if it is being held back.
        self.current: list[Event] | None = None
        self.fold: _Fold | None = None
        # Set when the span turned out to contain something a fold cannot represent. From then on this
        # loop is passed through untouched.
        self.giving_up = False
        # Call depth inside the buffered iteration, so an unbalanced frame is not folded away.
        self.depth = 0


class LoopCollapser:
    """Decides, event by event, what to emit now, what to hold, and what to fold.

    Pure and synchronous: ``feed`` returns the events to emit. It owns no clock, no numbering and no
    output, which is what makes it testable without a running program.
    """

    def __init__(
        self,
        *,
        keep_head: int = DEFAULT_KEEP_HEAD,
        keep_tail: int = DEFAULT_KEEP_TAIL,
        chunk: int = DEFAULT_CHUNK,
        min_iterations: int = DEFAULT_MIN_ITERATIONS,
        seq: Callable[[], int] | None = None,
    ) -> None:
        self.keep_head = max(0, keep_head)
        self.keep_tail = max(0, keep_tail)
        self.chunk = max(1, chunk)
        self.min_iterations = max(0, min_iterations)
        self._seq = seq or (lambda: 0)
        self._stack: list[_Region] = []
        self.folded_iterations = 0
        self.collapse_events = 0

    # -- the one entry point ----------------------------------------------

    def feed(self, kind: str, payload: dict[str, Any] | None) -> list[Event]:
        """Return the events to emit in place of this one."""
        data = payload or {}

        if kind == "loop_enter":
            out = self._flush_all_buffers()
            self._stack.append(_Region(int(data["region"])))
            out.append((kind, data))
            return out

        if kind == "loop_exit":
            out = self._close(int(data["region"]))
            out.append((kind, data))
            return out

        active = self._stack[-1] if self._stack else None
        if active is None or active.giving_up:
            return [(kind, data)]

        if kind == "loop_iter" and int(data.get("region", -1)) == active.region:
            return self._begin_iteration(active, data)

        # Everything else belongs to whichever iteration is open.
        if active.current is None:
            return [(kind, data)]

        if kind not in FOLDABLE:
            # Output, a question, an exception, a new object: real behaviour this cannot summarise.
            return self._give_up(active, (kind, data))

        if kind == "frame_push":
            active.depth += 1
        elif kind == "frame_pop":
            active.depth -= 1
            if active.depth < 0:
                # A return out of the loop's own frame. Folding across it would erase a frame change.
                return self._give_up(active, (kind, data))

        active.current.append((kind, data))
        return []

    # -- iteration boundaries ---------------------------------------------

    def _begin_iteration(self, active: _Region, data: dict[str, Any]) -> list[Event]:
        out: list[Event] = []

        # Close the iteration that was open.
        if active.current is not None:
            if active.depth != 0:
                return self._give_up(active, ("loop_iter", data))
            active.tail.append(active.current)
            active.current = None

        active.seen += 1

        # The head runs verbatim, and so does everything until the loop proves it is long enough to be
        # worth folding at all.
        if active.seen <= self.keep_head or active.seen <= self.min_iterations:
            out.extend(self._drain_tail(active))
            out.append(("loop_iter", data))
            return out

        # Past the head: hold this iteration back, and fold the oldest held one once the tail window
        # is full. This is the only reason anything is buffered - an iteration cannot be known to be
        # among the last few until the loop ends.
        active.current = [("loop_iter", data)]
        active.depth = 0
        while len(active.tail) > self.keep_tail:
            out.extend(self._fold_oldest(active))
        return out

    def _fold_oldest(self, active: _Region) -> list[Event]:
        oldest = active.tail.pop(0)
        if active.fold is None:
            active.fold = _Fold(active.region, self._seq())
        for kind, payload in oldest:
            active.fold.absorb(kind, payload)
        self.folded_iterations += 1
        if active.fold.iterations >= self.chunk:
            return self._emit_fold(active)
        return []

    def _emit_fold(self, active: _Region) -> list[Event]:
        fold = active.fold
        active.fold = None
        if fold is None or fold.empty:
            return []
        self.collapse_events += 1
        return [("collapse", fold.to_event(self._seq()))]

    def _drain_tail(self, active: _Region) -> list[Event]:
        """Emit held iterations verbatim, after whatever has been folded so far."""
        out = self._emit_fold(active)
        for iteration in active.tail:
            out.extend(iteration)
        active.tail.clear()
        return out

    # -- closing out -------------------------------------------------------

    def _close(self, region: int) -> list[Event]:
        out: list[Event] = []
        while self._stack:
            active = self._stack.pop()
            if active.current is not None:
                active.tail.append(active.current)
                active.current = None
            out.extend(self._drain_tail(active))
            if active.region == region:
                break
        return out

    def _give_up(self, active: _Region, event: Event) -> list[Event]:
        """Abandon folding this loop, emitting everything held in the order it happened.

        Correctness first. A loop that prints, raises, asks a question or allocates is left alone
        rather than summarised approximately: the step and output budgets are what bound those, not
        this.
        """
        active.giving_up = True
        out: list[Event] = []
        # Anything already folded still has to be described, or its state changes vanish.
        out.extend(self._emit_fold(active))
        for iteration in active.tail:
            out.extend(iteration)
        active.tail.clear()
        if active.current is not None:
            out.extend(active.current)
            active.current = None
        out.append(event)
        return out

    def _flush_all_buffers(self) -> list[Event]:
        out: list[Event] = []
        for active in self._stack:
            out.extend(self._drain_tail(active))
        return out

    def drain(self) -> list[Event]:
        """Everything still held, for the end of a run that never closed its loops."""
        out: list[Event] = []
        while self._stack:
            active = self._stack.pop()
            if active.current is not None:
                active.tail.append(active.current)
                active.current = None
            out.extend(self._drain_tail(active))
        return out

    def __iter__(self) -> Iterator[None]:  # pragma: no cover - not a container
        raise TypeError("LoopCollapser is not iterable")
