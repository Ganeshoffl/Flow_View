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
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, AsyncIterator, Callable

__all__ = ["RunLimits", "RunRequest", "Runner", "platform_guards"]

def _adapters_root() -> Path:
    """Where the Python tracer lives.

    Installed, it is a top-level package beside this one; in a checkout it is under `adapters/python`.
    The old answer was `parents[3]`, which is the repo root only in a checkout — so an installed
    flow_view looked for the tracer in whatever directory happened to sit three levels above
    site-packages, found nothing, and every run failed.

    Resolved through the import system rather than by guessing, because that is the one thing that
    knows where a package ended up.
    """
    spec = importlib.util.find_spec("flow_view_tracer")
    if spec is not None and spec.origin:
        return Path(spec.origin).resolve().parent.parent
    return Path(__file__).resolve().parents[3] / "adapters" / "python"


ADAPTERS = _adapters_root()

#: Where the JavaScript adapter lives.
#:
#: Not resolvable through the import system the way the Python one is — it is not a Python package — so this
#: is a path from the checkout. An installed wheel does not ship it yet, which is why
#: :func:`javascript_adapter_root` returns None rather than a path that does not exist: the capability check
#: reads that as "JavaScript is not available here" and says so, instead of every run failing at spawn.
_JAVASCRIPT_ROOT = Path(__file__).resolve().parents[3] / "adapters" / "javascript"


def javascript_adapter_root() -> Path | None:
    """The JavaScript adapter's package directory, if it is present."""
    return _JAVASCRIPT_ROOT if (_JAVASCRIPT_ROOT / "src" / "cli.js").is_file() else None


def _node_read_paths(workdir: str, root: Path) -> list[Path]:
    """Everything the JavaScript adapter must be able to read, and nothing else.

    Three things: the run directory holding the program, the adapter's own source, and wherever its
    dependencies actually live. That last one is the awkward case — pnpm puts a tree of symlinks in
    `adapters/javascript/node_modules` whose targets are hoisted to the workspace root, and node's
    permission model checks the resolved path. Granting only the adapter directory therefore fails at
    `import acorn` with `ERR_ACCESS_DENIED`, naming a file under a directory nobody thought to mention.
    """
    paths = [Path(workdir), root]
    # Every `node_modules` on the way up, not just the nearest. Stopping at the first one finds
    # `adapters/javascript/node_modules`, which under pnpm is a directory of symlinks pointing at
    # `<workspace>/node_modules/.pnpm/...` — so the grant covers the signposts and not the packages, and
    # `import acorn` is refused.
    for candidate in [root, *root.parents]:
        modules = candidate / "node_modules"
        if modules.is_dir():
            paths.append(modules.resolve())
    return paths


@dataclass(frozen=True)
class Adapter:
    """How to start one language's tracer.

    The server used to know only how to start Python: `sys.executable`, `-I`, a path ending in `cli.py`, a
    file called `main.py`. Adding a second language meant either branching at every one of those points or
    naming them once, here. Everything downstream of the spawn — reading JSON Lines, labelling where an
    answer came from, forwarding stdin, reaping the process — was already language-agnostic and is untouched.
    """

    language: str
    #: What the program is written to on disk. The extension is what makes an error message read right.
    source_name: str
    #: Executable plus any flags that must precede the script.
    launcher: list[str]
    #: The adapter's entry point.
    script: Path
    #: Flags this adapter's CLI understands, so the server never passes one that would be ignored in silence.
    accepts: frozenset[str]
    #: Extra environment for the child, on top of the scrubbed base.
    env: dict[str, str] = field(default_factory=dict)
    #: Whether a `RLIMIT_AS` ceiling can be applied. See the JavaScript note below.
    address_space_rlimit: bool = True


def _python_adapter(workdir: str, limits: "RunLimits") -> Adapter:
    return Adapter(
        language="python",
        source_name="main.py",
        launcher=[
            sys.executable,
            # Isolated mode: no user site-packages, no cwd on sys.path, environment ignored. It also
            # ignores PYTHONPATH, which is why the CLI is invoked by path rather than with -m — the
            # script puts its own parent directory on sys.path, so it imports under isolation.
            "-I",
        ],
        script=ADAPTERS / "flow_view_tracer" / "cli.py",
        accepts=frozenset(
            {
                "--session-id",
                "--max-steps",
                "--wall-ms",
                "--memory-mb",
                "--output-bytes",
                "--complete-heap",
            }
        ),
        env={
            "PYTHONHASHSEED": "0",  # deterministic iteration order, so a replay matches its recording
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
            "PYTHONPATH": str(ADAPTERS),
        },
    )


#: Where the Java adapter lives. A single source file, run without being built.
_JAVA_ROOT = Path(__file__).resolve().parents[3] / "adapters" / "java"


def java_adapter_source() -> Path | None:
    """The Java tracer's source file, wherever it ended up.

    Installed, it is shipped beside this package; in a checkout it is under `adapters/java`. Looked for in both
    places rather than guessed at, because an installed flow_view that reported Java as available and then
    failed to find its own adapter would be the worst of both answers.
    """
    installed = Path(__file__).resolve().parent / "adapters" / "java" / "src" / "FlowViewTracer.java"
    if installed.is_file():
        return installed
    tracer = _JAVA_ROOT / "src" / "FlowViewTracer.java"
    return tracer if tracer.is_file() else None


@lru_cache(maxsize=1)
def java_executable() -> str | None:
    """The real `java` binary, not whatever is first on PATH.

    A version manager — mise, asdf, sdkman — puts a *shim* on PATH: a small script that works out which
    installed version to dispatch to, using the environment it was started with. The child process here is
    started with almost no environment on purpose, and `HOME` deliberately points at the run directory rather
    than the user's, so the shim cannot find its own configuration and fails with

        mise ERROR java is not a valid shim

    before the JVM is ever reached. Asking Java where it lives, once, in *this* process where the environment is
    intact, sidesteps the shim entirely. Nothing about the scrubbing has to be relaxed to make Java work.
    """
    found = shutil.which("java")
    if found is None:
        return None
    try:
        result = subprocess.run(
            [found, "-XshowSettings:properties", "-version"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return found

    # `-XshowSettings` writes to stderr.
    for line in (result.stderr or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("java.home"):
            _, _, home = stripped.partition("=")
            candidate = Path(home.strip()) / "bin" / "java"
            if candidate.is_file():
                return str(candidate)
    return found


def _java_adapter(workdir: str, limits: "RunLimits") -> Adapter:
    tracer = java_adapter_source()
    if tracer is None:
        raise FileNotFoundError(
            "The Java adapter is not installed alongside this server, so Java cannot be run."
        )
    java = java_executable()
    if java is None:
        raise FileNotFoundError("Java is not on PATH, so Java cannot be run.")

    return Adapter(
        language="java",
        source_name="Main.java",
        # Source-file mode: `java Tracer.java` compiles and runs it in one step, so the adapter needs no
        # build. The tracer then compiles the *user's* program itself and drives it in a third JVM.
        launcher=[java],
        script=tracer,
        accepts=frozenset(
            {
                "--session-id",
                "--max-steps",
                "--wall-ms",
                "--memory-mb",
                "--output-bytes",
            }
        ),
        env={},
        # The tracer is a JVM and so is the program it drives, and neither can start inside a 512MB
        # address-space ceiling. The memory limit that does apply is passed to the program's own JVM as a
        # heap cap, by the tracer.
        address_space_rlimit=False,
    )


def _javascript_adapter(workdir: str, limits: "RunLimits") -> Adapter:
    root = javascript_adapter_root()
    if root is None:
        raise FileNotFoundError(
            "The JavaScript adapter is not installed alongside this server, so JavaScript cannot be run."
        )
    node = shutil.which("node")
    if node is None:
        raise FileNotFoundError("Node.js is not on PATH, so JavaScript cannot be run.")

    launcher = [
        node,
        # The real sandbox for a JavaScript run, and the only one node offers. It has to be applied from
        # out here: a process cannot switch its own permission model on.
        "--permission",
        *[f"--allow-fs-read={path}" for path in _node_read_paths(workdir, root)],
        # The memory ceiling, in the same units the request asked for. This is V8's heap limit rather than
        # an address-space rlimit, because RLIMIT_AS does not work here at all: V8 reserves a large virtual
        # region up front, so a 512 MB ceiling stops node *booting* — it dies with a trap before running a
        # line, which looks like flow_view being broken rather than a program using too much memory.
        f"--max-old-space-size={max(64, limits.memory_mb)}",
    ]

    return Adapter(
        language="javascript",
        source_name="main.js",
        launcher=launcher,
        script=root / "src" / "cli.js",
        accepts=frozenset(
            {
                "--session-id",
                "--max-steps",
                "--wall-ms",
                "--memory-mb",
                "--output-bytes",
            }
        ),
        # Nothing extra. The PYTHON* variables the Python child needs are meaningless here, and passing
        # them would be a small lie about what this process is.
        env={},
        address_space_rlimit=False,
    )


_ADAPTERS: dict[str, Callable[[str, "RunLimits"], Adapter]] = {
    "python": _python_adapter,
    "javascript": _javascript_adapter,
    "java": _java_adapter,
}


def adapter_for(language: str, workdir: str, limits: "RunLimits") -> Adapter:
    build = _ADAPTERS.get(language)
    if build is None:
        raise FileNotFoundError(f"There is no adapter for {language}.")
    return build(workdir, limits)

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


def _preexec(limits: RunLimits, *, address_space: bool = True) -> Callable[[], None] | None:
    """Build the child-side setup that applies rlimits and detaches the process group.

    Returns ``None`` where the platform cannot support it, so the caller can report the ceilings as
    inactive rather than silently skipping them.

    ``address_space`` is off for runtimes that reserve virtual memory far beyond what they use. Applying
    ``RLIMIT_AS`` to those does not cap anything; it stops them starting.
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

        if not address_space:
            return

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


def _child_env(workdir: str, adapter: Adapter) -> dict[str, str]:
    env = {name: os.environ[name] for name in _ENV_ALLOWLIST if name in os.environ}
    env["HOME"] = workdir
    env["TMPDIR"] = workdir
    env.update(adapter.env)
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
        limits = self.request.limits
        adapter = adapter_for(self.request.language, self._workdir, limits)

        source_path = Path(self._workdir) / adapter.source_name
        source_path.write_text(self.request.source, encoding="utf-8")

        command = [*adapter.launcher, str(adapter.script), "--source", str(source_path)]
        # Only the flags this adapter understands. Sending one it does not leaves the ceiling unenforced
        # while the request says it was asked for, and nothing anywhere reports the difference.
        optional: list[tuple[str, str | None]] = [
            ("--session-id", self.request.session_id),
            ("--max-steps", str(limits.max_steps)),
            ("--wall-ms", str(limits.wall_ms)),
            ("--memory-mb", str(limits.memory_mb)),
            ("--output-bytes", str(limits.output_bytes)),
            ("--complete-heap", None if self.request.complete_heap else "skip"),
        ]
        for flag, value in optional:
            if flag not in adapter.accepts:
                continue
            if value is None:
                command.append(flag)
            elif value != "skip":
                command.extend([flag, value])

        preexec = _preexec(limits, address_space=adapter.address_space_rlimit)
        if preexec is None:
            for name in ("cpu_time", "address_space", "file_size", "process_group_reaping"):
                self._guards[name] = False
        elif not adapter.address_space_rlimit:
            # Reported as absent because it is absent. The run has a memory ceiling — V8's heap limit, set
            # on the command line — but it is not this one, and saying otherwise would describe a
            # protection that is not the one in force.
            self._guards["address_space"] = False

        self._process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._workdir,
            env=_child_env(self._workdir, adapter),
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
            # Released in the order asyncio expects, while the loop is still running.
            #
            # Left to garbage collection, the subprocess transport closes its pipes from a finalizer — and if the
            # loop has gone by then, that finalizer raises `RuntimeError: Event loop is closed`. The warning
            # appears or does not depending on when the collector happens to run, which is precisely the kind of
            # intermittent failure this project has already chased down once before.
            if process.stdin is not None:
                try:
                    process.stdin.close()
                except Exception:
                    pass
            for pipe in (process.stdout, process.stderr):
                transport = getattr(pipe, "_transport", None)
                if transport is not None:
                    try:
                        transport.close()
                    except Exception:
                        pass
            # Returns at once for a process that has already finished, and is what lets the transport go.
            try:
                await process.wait()
            except Exception:
                pass

        if self._workdir:
            shutil.rmtree(self._workdir, ignore_errors=True)
            self._workdir = None

    @property
    def exit_code(self) -> int | None:
        return self._process.returncode if self._process else None
