"""Command-line entry point for the Python tracer.

Invoked by the server as a subprocess. Events go to stdout as JSON Lines, one per line, so the
reader can render the first step while the program is still running.

The program's own output never reaches the real stdout: the tracer intercepts ``sys.stdout`` and
turns writes into trace events, which is what keeps output attributed to the step that produced it.
Anything that bypasses ``sys.stdout`` entirely — a direct ``os.write(1, ...)`` — would corrupt the
event stream, so stdout is redirected to stderr at the file-descriptor level as a backstop.

Usage:
    python -m flow_view_tracer.cli --source program.py [--max-steps N] [--session-id ID]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="flow_view_tracer", description=__doc__)
    parser.add_argument("--source", required=True, help="path to the program to trace")
    parser.add_argument("--session-id", default="local")
    parser.add_argument("--max-steps", type=int, default=200_000)
    parser.add_argument("--wall-ms", type=int, default=30_000)
    parser.add_argument("--memory-mb", type=int, default=512)
    parser.add_argument("--output-bytes", type=int, default=1_048_576)
    parser.add_argument("--max-depth", type=int, default=3)
    parser.add_argument("--max-objects", type=int, default=128)
    parser.add_argument("--max-slots", type=int, default=32)
    parser.add_argument(
        "--complete-heap",
        action="store_true",
        help="read the whole reachable heap each step; correct at any size, affordable only when small",
    )
    # Loop folding. On by default: a long loop is the ordinary case that makes a trace unusable, and
    # `--no-collapse` is there for anyone who needs the raw article.
    parser.add_argument(
        "--no-collapse",
        action="store_true",
        help="record every iteration of every loop, however many there are",
    )
    parser.add_argument(
        "--collapse-keep",
        type=int,
        default=None,
        help="iterations kept in full at each end of a folded loop",
    )
    parser.add_argument(
        "--collapse-chunk",
        type=int,
        default=None,
        help="iterations folded into one composite step before it is emitted",
    )
    parser.add_argument(
        "--collapse-min",
        type=int,
        default=None,
        help="a loop shorter than this is never folded",
    )
    parser.add_argument("--allow-network", action="store_true")
    parser.add_argument("--allow-subprocesses", action="store_true")
    parser.add_argument("--no-filesystem-guard", action="store_true")
    args = parser.parse_args(argv)

    source_path = Path(args.source)
    try:
        source = source_path.read_text(encoding="utf-8")
    except OSError as error:
        print(json.dumps({"seq": 0, "t": "note", "level": "warn", "text": str(error)}))
        return 2

    # Imported after argument parsing so a bad invocation fails fast and cheaply.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from flow_view_tracer.emit import Limits  # noqa: PLC0415
    from flow_view_tracer.guards import apply_guards  # noqa: PLC0415
    from flow_view_tracer.tracer import Tracer, TracerOptions  # noqa: PLC0415
    from flow_view_tracer.emit import Emitter  # noqa: PLC0415
    from flow_view_tracer import collapse as collapse_module  # noqa: PLC0415

    workdir = str(source_path.parent.resolve())
    guards = apply_guards(
        workdir,
        network=not args.allow_network,
        filesystem=not args.no_filesystem_guard,
        subprocesses=not args.allow_subprocesses,
    )

    # The event stream owns the real stdout. Anything the program writes directly to descriptor 1 —
    # bypassing sys.stdout, so beyond the tracer's interception — would otherwise land in the middle
    # of a JSON line and corrupt the stream. Sending it to stderr keeps the stream parseable and the
    # output visible in the server log rather than silently discarded.
    events_out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    os.dup2(2, 1)

    limits = Limits(
        max_steps=args.max_steps,
        wall_ms=args.wall_ms,
        memory_mb=args.memory_mb,
        output_bytes=args.output_bytes,
    )
    collapse: dict[str, int] | None = None
    if not args.no_collapse:
        keep = args.collapse_keep
        collapse = {
            "keep_head": collapse_module.DEFAULT_KEEP_HEAD if keep is None else keep,
            "keep_tail": collapse_module.DEFAULT_KEEP_TAIL if keep is None else keep,
            "chunk": args.collapse_chunk or collapse_module.DEFAULT_CHUNK,
            "min_iterations": (
                collapse_module.DEFAULT_MIN_ITERATIONS
                if args.collapse_min is None
                else args.collapse_min
            ),
        }

    options = TracerOptions(
        max_depth=args.max_depth,
        max_objects=args.max_objects,
        max_slots=None if args.max_slots <= 0 else args.max_slots,
        complete_heap=args.complete_heap,
        session_id=args.session_id,
        collapse=collapse,
    )

    collapser = None
    if collapse is not None:
        from flow_view_tracer.collapse import LoopCollapser  # noqa: PLC0415

        collapser = LoopCollapser(**collapse)
    emitter = Emitter(events_out, limits=limits, collapser=collapser)
    tracer = Tracer(source, str(source_path), emitter, options)

    header = tracer.session_header()
    header["guards_active"] = guards.as_list()
    events_out.write(json.dumps({"schema": "flow_view/trace@1", "session": header}))
    events_out.write("\n")
    events_out.flush()

    for name, reason in guards.unavailable:
        emitter.note("warn", f"The {name} guard is not active on this platform: {reason}")

    # Say so before the run, because the alternative is a reader concluding their __del__ never ran.
    for line in tracer.analysis.finalizer_lines:
        emitter.note(
            "warn",
            f"The __del__ on line {line} will not run where it would outside flow_view. Tracing "
            "holds on to objects so their ids stay stable, which delays collection until after the "
            "run, so anything the finalizer prints may be missing from this trace entirely.",
            once=False,
        )

    status = tracer.run()
    events_out.flush()
    return 0 if status in ("ok", "step_limit", "timeout") else 1


if __name__ == "__main__":
    raise SystemExit(main())
