"""What the source says about each line, worked out once before the program runs.

Three questions get answered here, and all three exist to serve decisions the tracer has to make
thousands of times per second.

**Can this line mutate the heap?**
    A line with no call, no subscript store, no attribute store and no augmented assignment cannot
    change an object in place. Those lines skip the heap walk entirely, at 0.3µs instead of up to
    75µs. Measurement showed this is the single cheapest large saving available
    (``docs/decisions/0001-reading-the-python-heap.md``).

**Which names does it mention?**
    A line can only mutate what it can reach, and what it can reach starts from the names it writes
    down. ``values[i] = x`` can touch ``values`` and nothing else, so the walk is rooted there rather
    than at every local in scope.

**Is it a branch, and where do its arms begin?**
    The condition's *source text* comes from here. Its *outcome* does not: that is observed at
    runtime by seeing which line executes next. Evaluating a user's condition a second time to learn
    its value could fire side effects and change the program being visualized — ``if queue.pop():``
    must never run twice.

Parsing happens once per file. Nothing in this module runs on the hot path.
"""

from __future__ import annotations

import ast
from bisect import bisect_right
from dataclasses import dataclass, field
from typing import Iterable

__all__ = ["BranchInfo", "LineInfo", "LoopInfo", "SourceAnalysis", "analyze"]


@dataclass(frozen=True)
class BranchInfo:
    """A control-flow decision made on a line."""

    kind: str
    """Schema ``BranchKind``: if, elif, else, while, for, ternary, guard."""

    expr: str
    """Source text of the condition, for display and narration."""

    body_line: int
    """First line of the arm taken when the condition holds."""

    else_line: int | None
    """First line of the arm taken when it does not, when one exists."""

    after_line: int | None
    """First line following the whole statement."""


@dataclass(frozen=True)
class LoopInfo:
    """A loop whose iterations are worth counting and collapsing."""

    line_start: int
    line_end: int
    kind: str


@dataclass
class LineInfo:
    """What the tracer needs to know before handling a line event."""

    line: int
    end_line: int
    may_mutate: bool
    """False only when the line provably cannot change an object in place."""

    names: tuple[str, ...]
    """Names mentioned on the line, used as heap-walk roots."""

    branch: BranchInfo | None = None
    loop: LoopInfo | None = None
    is_loop_header: bool = False
    jump: str | None = None
    """Set to break or continue when the line is that statement."""


#: Node types that can change an object without rebinding a name. A call is included because any
#: call may mutate anything it is handed, and the analysis must err toward doing the walk.
_MUTATING_NODES = (
    ast.Call,
    ast.AugAssign,
    ast.Delete,
    ast.Await,
    ast.Yield,
    ast.YieldFrom,
    ast.NamedExpr,
)


def _targets_a_container(node: ast.AST) -> bool:
    """True when a store targets a subscript or an attribute rather than a bare name."""
    targets: list[ast.AST] = []
    if isinstance(node, ast.Assign):
        targets.extend(node.targets)
    elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
        targets.append(node.target)
    elif isinstance(node, ast.For):
        targets.append(node.target)
    elif isinstance(node, ast.Delete):
        targets.extend(node.targets)

    for target in targets:
        for sub in ast.walk(target):
            if isinstance(sub, (ast.Subscript, ast.Attribute)):
                return True
    return False


def _own_nodes(node: ast.stmt) -> Iterable[ast.AST]:
    """Nodes belonging to a statement itself, not to its nested body.

    An ``if`` statement's own footprint is its test. Walking into the body would attribute a call
    made three lines later to the ``if`` line, making every compound statement look like it mutates.
    """
    skip: list[ast.AST] = []
    for attribute in ("body", "orelse", "finalbody", "handlers"):
        block = getattr(node, attribute, None)
        if isinstance(block, list):
            skip.extend(block)

    skipped_ids = {id(item) for item in skip}
    stack: list[ast.AST] = [node]
    while stack:
        current = stack.pop()
        yield current
        for child in ast.iter_child_nodes(current):
            if id(child) not in skipped_ids:
                stack.append(child)


def _names_in(nodes: Iterable[ast.AST]) -> tuple[str, ...]:
    found: list[str] = []
    seen: set[str] = set()
    for node in nodes:
        if isinstance(node, ast.Name) and node.id not in seen:
            seen.add(node.id)
            found.append(node.id)
    return tuple(found)


def _source_of(node: ast.AST, source: str) -> str:
    """The condition as the user wrote it, falling back to a normalized rendering."""
    try:
        segment = ast.get_source_segment(source, node)
        if segment:
            return " ".join(segment.split())
    except Exception:
        pass
    try:
        return ast.unparse(node)
    except Exception:
        return "<condition>"


def _first_line(block: list[ast.stmt]) -> int | None:
    return block[0].lineno if block else None


def _last_line(node: ast.stmt) -> int:
    return getattr(node, "end_lineno", node.lineno) or node.lineno


class SourceAnalysis:
    """Per-line facts for one source file."""

    def __init__(self, path: str, source: str) -> None:
        self.path = path
        self.source = source
        self._lines: list[LineInfo] = []
        self._starts: list[int] = []
        self._loops: dict[int, LoopInfo] = {}
        self._failed: str | None = None
        self._build(source)

    # -- construction ------------------------------------------------------

    def _build(self, source: str) -> None:
        try:
            tree = ast.parse(source, filename=self.path)
        except SyntaxError as error:
            # Recorded rather than raised: the runner reports a syntax error as a diagnostic on the
            # offending line, and the tracer must still be constructible.
            self._failed = f"{error.msg} (line {error.lineno})"
            return

        collected: dict[int, LineInfo] = {}

        for node in ast.walk(tree):
            if not isinstance(node, ast.stmt):
                continue

            own = list(_own_nodes(node))
            may_mutate = any(isinstance(n, _MUTATING_NODES) for n in own) or _targets_a_container(
                node
            )

            info = LineInfo(
                line=node.lineno,
                end_line=_last_line(node),
                may_mutate=may_mutate,
                names=_names_in(own),
            )

            if isinstance(node, ast.Break):
                info.jump = "break"
            elif isinstance(node, ast.Continue):
                info.jump = "continue"

            if isinstance(node, ast.If):
                # `elif` is a nested If inside orelse; its lineno is the elif line, so it is
                # reported as an elif rather than as a second if.
                kind = "elif" if getattr(node, "_fv_is_elif", False) else "if"
                info.branch = BranchInfo(
                    kind=kind,
                    expr=_source_of(node.test, source),
                    body_line=_first_line(node.body) or node.lineno,
                    else_line=_first_line(node.orelse),
                    after_line=_last_line(node) + 1,
                )
                for child in node.orelse:
                    if isinstance(child, ast.If) and child.lineno == node.orelse[0].lineno:
                        setattr(child, "_fv_is_elif", True)

            elif isinstance(node, (ast.While, ast.For, ast.AsyncFor)):
                kind = "while" if isinstance(node, ast.While) else "for"
                test = node.test if isinstance(node, ast.While) else node.iter
                loop = LoopInfo(
                    line_start=node.lineno, line_end=_last_line(node), kind=kind
                )
                info.loop = loop
                info.is_loop_header = True
                info.branch = BranchInfo(
                    kind=kind,
                    expr=_source_of(test, source),
                    body_line=_first_line(node.body) or node.lineno,
                    else_line=_first_line(node.orelse),
                    after_line=_last_line(node) + 1,
                )
                self._loops[node.lineno] = loop

            # An outer statement is recorded first by ast.walk, so an inner one on the same line
            # (a nested elif, say) should win.
            existing = collected.get(node.lineno)
            if existing is None or info.end_line <= existing.end_line:
                collected[node.lineno] = info

        self._starts = sorted(collected)
        self._lines = [collected[line] for line in self._starts]

    # -- queries -----------------------------------------------------------

    @property
    def syntax_error(self) -> str | None:
        """The parse failure, if the file could not be analysed."""
        return self._failed

    def at(self, line: int) -> LineInfo | None:
        """Facts for the statement covering ``line``.

        Returns ``None`` when no statement claims it, in which case the caller must assume the line
        might do anything. Guessing "harmless" would silently drop mutations.
        """
        index = bisect_right(self._starts, line) - 1
        while index >= 0:
            info = self._lines[index]
            if info.line <= line <= info.end_line:
                return info
            index -= 1
        return None

    def loop_at(self, line: int) -> LoopInfo | None:
        return self._loops.get(line)

    def line_count(self) -> int:
        return len(self.source.splitlines())


def analyze(path: str, source: str) -> SourceAnalysis:
    """Analyse one source file. Called once per run, never on the hot path."""
    return SourceAnalysis(path, source)
