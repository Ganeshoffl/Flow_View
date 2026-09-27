"""Running a traced program as a child process.

Two jobs: apply the ceilings that only work from outside the interpreter, and make sure nothing
outlives its session.

## Why a subprocess and not a thread

A traced program can loop forever, exhaust memory, or die in a way no exception handler catches. In
a thread, each of those takes the server with it. In a child process, each of them is a process the
supervisor kills.

## Why not Docker by default

Requiring Docker would contradict the goal of a tool anyone can install, and the threat model does
not call for it: flow_view runs code the user already has on their own machine and could run
directly. Guards here exist to stop *accidents* — a runaway loop, a full disk — not an attacker who
already owns the machine. Docker remains available for anyone binding beyond localhost, behind the
same interface, so only the launcher changes.

Every ceiling reports whether it is actually in force. The UI states what is protecting a run rather
than implying protection it does not have.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable

__all__ = ["RunLimits", "RunRequest", "Runner", "platform_guards"]

ADAPTERS = Path(__file__).resolve().parents[3] / "adapters" / "python"

#: How long a program may sit on an unanswered question before the run is given up on, in seconds.
#:
#: Generous, because the alternative is ending a run while its user is still reading. Finite, because
#: a closed tab must not leave a traced program parked on a read that will never be answered.
UNANSWERED_DEADLINE = 15 * 60

try:  # POSIX only; absent on Windows.
    import resource
except ImportError:  # pragma: no cover - platform dependent
    resource = None  # type: ignore[assignment]


@dataclass
class RunLimits:
    """Ceilings for one run."""

    max_steps: int = 200_000
    wall_ms: int = 30_000
    memory_mb: int = 512
    output_bytes: int = 1_048_576
    cpu_seconds: int = 30
    max_file_mb: int = 16


@dataclass
class RunRequest:
    """What to run."""

    source: str
    language: str = "python"
    session_id: str = "local"
    stdin: str | None = None
    limits: RunLimits = field(default_factory=RunLimits)
    complete_heap: bool = False


def platform_guards() -> dict[str, bool]:
    """Which process-level ceilings this platform can actually enforce."""
    available = resource is not None
    return {
        "cpu_time": available,
        "address_space": available,
        "file_size": available,
        "wall_clock": True,
        "process_group_reaping": hasattr(os, "killpg"),
        "temp_working_directory": True,
        "scrubbed_environment": True,
    }


def _preexec(limits: RunLimits) -> Callable[[], None] | None:
    """Build the child-side setup that applies rlimits and detaches the process group.

    Returns ``None`` where the platform cannot support it, so the caller can report the ceilings as
    inactive rather than silently skipping them.
    """
    if resource is None or not hasattr(os, "setsid"):
        return None

    def setup() -> None:
        # Its own process group, so the whole tree can be signalled at once. A child that spawned
        # grandchildren would otherwise leave them behind when the parent is killed.
        os.setsid()

        resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_seconds, limits.cpu_seconds + 1))
        size = limits.max_file_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_FSIZE, (size, size))
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
        try:
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        except (ValueError, OSError):
            pass

        # Address space is set last and tolerates failure. Too low a value makes the interpreter fail
        # to start at all, which would look like a flow_view bug rather than a memory limit; a
        # missing ceiling that is reported is better than a run that cannot begin.
        try:
            memory = limits.memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        except (ValueError, OSError):
            pass

    return setup


#: Variables worth passing through. Everything else is dropped, so a traced program cannot read the
#: user's tokens, and cannot be steered by PYTHON* variables the server happens to be running with.
_ENV_ALLOWLIST = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "HOME", "SYSTEMROOT", "TEMP", "TMP")


def _child_env(workdir: str) -> dict[str, str]:
    env = {name: os.environ[name] for name in _ENV_ALLOWLIST if name in os.environ}
    env["HOME"] = workdir
    env["TMPDIR"] = workdir
    env["PYTHONHASHSEED"] = "0"  # deterministic iteration order, so a replay matches its recording
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONPATH"] = str(ADAPTERS)
    return env


class Runner:
    """Owns one child process and the event stream coming out of it."""

    def __init__(self, request: RunRequest) -> None:
        self.request = request
        self._process: asyncio.subprocess.Process | None = None
        self._workdir: str | None = None
        self._guards = platform_guards()
        self._closed = False
        # How many lines were supplied up front. The pipe is first-in-first-out, so the first this
        # many answers the program reads are the prefilled ones and everything after was typed by a
        # person. See _label_stdin_source.
        self._prefilled_lines = 0

    @property
    def guards(self) -> dict[str, bool]:
        return dict(self._guards)

    # -- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        self._workdir = tempfile.mkdtemp(prefix="flow_view_run_")
        source_path = Path(self._workdir) / "main.py"
        source_path.write_text(self.request.source, encoding="utf-8")

        limits = self.request.limits
        command = [
            sys.executable,
            # Isolated mode: no user site-packages, no cwd on sys.path, environment ignored. It also
            # ignores PYTHONPATH, which is why the CLI is invoked by path rather than with -m — the
            # script puts its own parent directory on sys.path, so it imports under isolation.
            "-I",
            str(ADAPTERS / "flow_view_tracer" / "cli.py"),
            "--source",
            str(source_path),
            "--session-id",
            self.request.session_id,
            "--max-steps",
            str(limits.max_steps),
            "--wall-ms",
            str(limits.wall_ms),
            "--memory-mb",
            str(limits.memory_mb),
            "--output-bytes",
            str(limits.output_bytes),
        ]
        if self.request.complete_heap:
            command.append("--complete-heap")

        preexec = _preexec(limits)
        if preexec is None:
            for name in ("cpu_time", "address_space", "file_size", "process_group_reaping"):
                self._guards[name] = False

        self._process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._workdir,
            env=_child_env(self._workdir),
            preexec_fn=preexec,
            # A long JSON line must not be truncated into invalid JSON.
            limit=8 * 1024 * 1024,
        )

        if self.request.stdin:
            # Prefilled input, so the run produces a fully scrubbable trace with no human involved.
            #
            # The trailing newline is not cosmetic. `input()` reads a *line*, so text that does not end
            # in one leaves the program blocked on a read that can never complete: typing `Ada` into
            # the input box and pressing Run hung the run forever, with the UI showing "running".
            # `send_stdin` below always did this; this path did not.
            text = self.request.stdin
            if not text.endswith("\n"):
                text += "\n"
            self._prefilled_lines = text.count("\n")
            assert self._process.stdin is not None
            self._process.stdin.write(text.encode("utf-8"))
            await self._process.stdin.drain()

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        """Yield events as they arrive.

        A line that will not parse is reported as a diagnostic rather than raised. Losing the rest of
        a run because one event was malformed would turn a small bug into a total failure.
        """
        if self._process is None or self._process.stdout is None:
            raise RuntimeError("the runner was not started")

        wall_deadline = self.request.limits.wall_ms / 1000 + 5
        stream = self._process.stdout
        # Silence means something has gone wrong — unless the program is waiting for input, in which
        # case silence is exactly what it should be doing. Applying the execution deadline then would
        # end a run for being patient, and blame the program for the time a person spent thinking.
        #
        # It is still bounded, just far more loosely, so an abandoned tab cannot leave a traced program
        # parked on a read forever.
        awaiting_input = False

        while True:
            try:
                line = await asyncio.wait_for(
                    stream.readline(),
                    timeout=UNANSWERED_DEADLINE if awaiting_input else wall_deadline,
                )
            except asyncio.TimeoutError:
                yield {
                    "t": "note",
                    "level": "warn",
                    "text": (
                        "Nobody answered, so the run was ended."
                        if awaiting_input
                        else "The program stopped responding and was ended."
                    ),
                }
                await self.stop()
                return
            except (asyncio.LimitOverrunError, ValueError):
                yield {
                    "t": "note",
                    "level": "warn",
                    "text": "A single trace event was too large to read and was skipped.",
                }
                continue

            if not line:
                return
            text = line.decode("utf-8", "replace").strip()
            if not text:
                continue
            try:
                event = json.loads(text)
            except json.JSONDecodeError:
                yield {
                    "t": "note",
                    "level": "warn",
                    "text": "An unreadable line arrived from the tracer and was skipped.",
                }
                continue
            kind = event.get("t")
            if kind == "stdin_request":
                awaiting_input = True
            elif kind == "stdin_response":
                awaiting_input = False
                self._label_stdin_source(event)
            yield event

    def _label_stdin_source(self, event: dict[str, Any]) -> None:
        """Say where an answer actually came from.

        The tracer cannot know. From inside the traced program, input supplied up front and input
        typed by a person are the same bytes on the same pipe; all it can do is time the read, which
        mislabels anything answered by a machine faster than a human could. Here the answer is known
        exactly, because this is the end that supplied it: a pipe is first-in-first-out, so the first
        `_prefilled_lines` answers are the prefilled ones and every answer after them was typed while
        the program waited.

        The measured `waited_ms` the tracer recorded is left alone. It is a fact, and it is the more
        interesting one for anyone asking how long a run sat idle.
        """
        if self._prefilled_lines > 0:
            self._prefilled_lines -= 1
            event["source"] = "prefilled"
        else:
            event["source"] = "interactive"

    async def send_stdin(self, text: str) -> None:
        """Answer a blocking read in the traced program."""
        if self._process is None or self._process.stdin is None:
            return
        if not text.endswith("\n"):
            text += "\n"
        try:
            self._process.stdin.write(text.encode("utf-8"))
            await self._process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            # The program exited before the answer arrived. Nothing to do, and nothing wrong.
            pass

    async def stderr_text(self) -> str:
        """Anything the child wrote to stderr, for diagnosing an adapter that failed to start."""
        if self._process is None or self._process.stderr is None:
            return ""
        try:
            data = await asyncio.wait_for(self._process.stderr.read(), timeout=1.0)
            return data.decode("utf-8", "replace")
        except (asyncio.TimeoutError, Exception):
            return ""

    async def stop(self) -> None:
        """End the run and remove everything it touched.

        Termination escalates: the group is asked to stop, then made to. A program ignoring SIGTERM —
        or stuck in C code that never checks signals — must not be able to outlive its session.
        """
        if self._closed:
            return
        self._closed = True
        process = self._process

        if process is not None and process.returncode is None:
            for send, wait in ((signal.SIGTERM, 2.0), (signal.SIGKILL, 2.0)):
                try:
                    if hasattr(os, "killpg"):
                        os.killpg(os.getpgid(process.pid), send)
                    else:  # pragma: no cover - platform dependent
                        process.send_signal(send)
                except (ProcessLookupError, PermissionError, OSError):
                    break
                try:
                    await asyncio.wait_for(process.wait(), timeout=wait)
                    break
                except asyncio.TimeoutError:
                    continue

        if process is not None:
            for pipe in (process.stdin, process.stdout, process.stderr):
                transport = getattr(pipe, "_transport", None)
                if transport is not None:
                    try:
                        transport.close()
                    except Exception:
                        pass

        if self._workdir:
            shutil.rmtree(self._workdir, ignore_errors=True)
            self._workdir = None

    @property
    def exit_code(self) -> int | None:
        return self._process.returncode if self._process else None
