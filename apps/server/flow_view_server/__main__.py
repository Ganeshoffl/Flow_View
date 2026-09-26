"""The ``flow-view`` command.

Starts the local server and opens a browser. Loopback by default: flow_view is a tool you install,
not a service you publish, and binding wider without being asked would expose an execution surface
the user never chose to share.
"""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import webbrowser
from pathlib import Path


def _static_dir(explicit: str | None) -> Path | None:
    """Locate the built UI.

    A wheel ships it beside the package; a source checkout has it under ``apps/web/dist``. Absent
    either, the API still serves and the reason is reported, rather than the command appearing to
    start and then showing nothing.
    """
    if explicit:
        return Path(explicit).expanduser().resolve()

    packaged = Path(__file__).resolve().parent / "static"
    if packaged.is_dir():
        return packaged

    checkout = Path(__file__).resolve().parents[3] / "apps" / "web" / "dist"
    return checkout if checkout.is_dir() else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="flow-view", description="See what your code does while it runs.")
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind (default: loopback)")
    parser.add_argument("--port", type=int, default=7474)
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    parser.add_argument("--static", help="path to a built UI, overriding auto-detection")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("flow_view")

    try:
        import uvicorn
    except ImportError:
        print(
            "flow-view needs uvicorn and fastapi.\n  pip install 'flow-view[server]'",
            file=sys.stderr,
        )
        return 2

    from .app import create_app

    static = _static_dir(args.static)
    if static is None:
        log.warning(
            "No built UI found, so only the API is being served. "
            "Build it with: pnpm --filter @flow-view/web build"
        )

    app = create_app(static)
    url = f"http://{args.host}:{args.port}/"

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        log.warning(
            "Binding to %s exposes program execution to your network. "
            "Use FLOW_VIEW_SANDBOX=docker if that is intended.",
            args.host,
        )

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    print(f"flow_view is running at {url}")
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
