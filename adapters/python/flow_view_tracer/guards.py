"""In-process guards applied before a traced program starts.

These are the protections that only work from *inside* the interpreter. Process-level ceilings —
CPU, address space, file size — belong to the runner and are applied before the interpreter starts.

The distinction matters for honesty. Every guard here reports whether it is actually in force, and
the session header publishes that list, so the UI can state what is protecting a run rather than
implying a safety it does not have.

What these defend against is **accidents**: a runaway loop, a script that fills the disk, an example
pasted from the internet that quietly calls home. They are not a security boundary. flow_view runs
code the user already has on their own machine and could run directly, and a Python-level guard is
bypassable from a C extension. Anyone exposing flow_view beyond localhost should use the Docker
sandbox, which is what it is for.
"""

from __future__ import annotations

import builtins
from typing import Any, Callable

__all__ = ["GuardReport", "block_network", "restrict_filesystem", "apply_guards"]


class GuardReport:
    """Which guards were requested, and which are genuinely active."""

    __slots__ = ("active", "unavailable")

    def __init__(self) -> None:
        self.active: list[str] = []
        self.unavailable: list[tuple[str, str]] = []

    def enabled(self, name: str) -> None:
        self.active.append(name)

    def failed(self, name: str, reason: str) -> None:
        self.unavailable.append((name, reason))

    def as_list(self) -> list[str]:
        return list(self.active)


def block_network(report: GuardReport) -> None:
    """Make network calls fail loudly.

    Sockets are replaced rather than firewalled, because a firewall needs privileges flow_view
    should not ask for. A program that tries to open a connection gets a clear error naming
    flow_view, instead of a confusing timeout.
    """
    try:
        import socket

        class _Blocked(OSError):
            pass

        def refuse(*_args: Any, **_kwargs: Any) -> Any:
            raise _Blocked(
                "flow_view blocks network access while tracing. "
                "Visualized programs are meant to be self-contained."
            )

        socket.socket = refuse  # type: ignore[assignment]
        socket.create_connection = refuse  # type: ignore[assignment]
        if hasattr(socket, "create_server"):
            socket.create_server = refuse  # type: ignore[assignment]
        report.enabled("network blocked (python level)")
    except Exception as error:  # pragma: no cover - defensive
        report.failed("network", str(error))


def restrict_filesystem(report: GuardReport, workdir: str) -> None:
    """Confine writes to the run's own directory.

    Reads are left alone: a program that opens a data file it shipped with should work, and refusing
    reads would break more than it protects. Writes are the accident worth preventing — a script
    that truncates a file the user cared about.
    """
    try:
        import os

        real_open = builtins.open
        workdir_real = os.path.realpath(workdir)

        def guarded_open(file: Any, mode: str = "r", *args: Any, **kwargs: Any) -> Any:
            if any(flag in mode for flag in ("w", "a", "x", "+")):
                try:
                    target = os.path.realpath(os.fspath(file))
                except TypeError:
                    # A file descriptor rather than a path. Already open; nothing to check.
                    return real_open(file, mode, *args, **kwargs)
                if not target.startswith(workdir_real + os.sep) and target != workdir_real:
                    raise PermissionError(
                        f"flow_view only allows writes inside the run's own directory. "
                        f"Refused: {target}"
                    )
            return real_open(file, mode, *args, **kwargs)

        builtins.open = guarded_open  # type: ignore[assignment]
        report.enabled("writes confined to the run directory")
    except Exception as error:  # pragma: no cover - defensive
        report.failed("filesystem", str(error))


def _disable_subprocesses(report: GuardReport) -> None:
    """Refuse to spawn child processes.

    A child would escape every ceiling applied to this one: its own CPU budget, its own memory, and
    no tracing. Refusing is both safer and more honest than tracing a program whose real work
    happens somewhere invisible.
    """
    try:
        import os
        import subprocess

        def refuse(*_args: Any, **_kwargs: Any) -> Any:
            raise PermissionError(
                "flow_view does not allow a traced program to start another process."
            )

        subprocess.Popen = refuse  # type: ignore[assignment]
        subprocess.run = refuse  # type: ignore[assignment]
        for name in ("system", "popen", "fork", "forkpty", "execv", "execve", "spawnv"):
            if hasattr(os, name):
                setattr(os, name, refuse)
        report.enabled("child processes refused")
    except Exception as error:  # pragma: no cover - defensive
        report.failed("subprocess", str(error))


def apply_guards(
    workdir: str,
    *,
    network: bool = True,
    filesystem: bool = True,
    subprocesses: bool = True,
) -> GuardReport:
    """Apply the in-process guards and report what took effect."""
    report = GuardReport()
    if network:
        block_network(report)
    if filesystem:
        restrict_filesystem(report, workdir)
    if subprocesses:
        _disable_subprocesses(report)
    return report
