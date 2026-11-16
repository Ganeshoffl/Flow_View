"""Parse GDB/MI records without mistaking quoted commas or braces for delimiters.

The debugger is an external process: its output is data, never Python code or a shell command.
MI tuples and result-lists may repeat keys, so retain repeated values in a list.
"""

from __future__ import annotations

import ast
import contextlib
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Record:
    token: int | None
    kind: str
    name: str | None
    value: Any


class _Parser:
    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0

    def quoted(self) -> str:
        start = self.pos
        if self.text[self.pos] != '"':
            raise ValueError("expected MI string")
        self.pos += 1
        while self.pos < len(self.text):
            char = self.text[self.pos]
            self.pos += 1
            if char == "\\":
                self.pos += 1
            elif char == '"':
                return ast.literal_eval(self.text[start : self.pos])
        raise ValueError("unterminated MI string")

    def name(self) -> str:
        start = self.pos
        while self.pos < len(self.text) and (
            self.text[self.pos].isalnum() or self.text[self.pos] in "_-."
        ):
            self.pos += 1
        if self.pos == start:
            raise ValueError("expected MI field name")
        return self.text[start : self.pos]

    def value(self) -> Any:
        if self.pos >= len(self.text):
            raise ValueError("missing MI value")
        opener = self.text[self.pos]
        if opener == '"':
            return self.quoted()
        if opener not in "{[":
            raise ValueError(f"unexpected MI value: {opener!r}")
        self.pos += 1
        closing = "}" if opener == "{" else "]"
        values: list[Any] = []
        fields: dict[str, Any] = {}
        duplicates: set[str] = set()
        while self.pos < len(self.text) and self.text[self.pos] != closing:
            before = self.pos
            try:
                key = self.name()
                if self.pos >= len(self.text) or self.text[self.pos] != "=":
                    self.pos = before
                    values.append(self.value())
                else:
                    self.pos += 1
                    item = self.value()
                    if key in fields:
                        if key in duplicates:
                            fields[key].append(item)
                        else:
                            fields[key] = [fields[key], item]
                            duplicates.add(key)
                    else:
                        fields[key] = item
            except ValueError:
                self.pos = before
                values.append(self.value())
            if self.pos < len(self.text) and self.text[self.pos] == ",":
                self.pos += 1
            elif self.pos < len(self.text) and self.text[self.pos] != closing:
                raise ValueError("expected comma or closing delimiter in MI value")
        if self.pos >= len(self.text):
            raise ValueError("unclosed MI value")
        self.pos += 1
        if fields and values:
            raise ValueError("mixed MI field and value list")
        return fields if opener == "{" or fields else values

    def fields(self) -> dict[str, Any]:
        output: dict[str, Any] = {}
        while self.pos < len(self.text):
            key = self.name()
            if self.pos >= len(self.text) or self.text[self.pos] != "=":
                raise ValueError("expected equals in MI result")
            self.pos += 1
            output[key] = self.value()
            if self.pos == len(self.text):
                break
            if self.text[self.pos] != ",":
                raise ValueError("unexpected trailing MI result")
            self.pos += 1
        return output


def parse_record(line: str) -> Record | None:
    """Decode one MI result/async/stream record; ignore the GDB prompt."""
    text = line.strip()
    if not text or text == "(gdb)":
        return None
    pos = 0
    while pos < len(text) and text[pos].isdigit():
        pos += 1
    token = int(text[:pos]) if pos else None
    if pos == len(text) or text[pos] not in "^*+=~@&":
        raise ValueError(f"invalid MI record: {text[:80]}")
    kind = text[pos]
    parser = _Parser(text[pos + 1 :])
    if kind in "~@&":
        value = parser.quoted()
        if parser.pos != len(parser.text):
            raise ValueError("trailing MI stream data")
        return Record(token, kind, None, value)
    name = parser.name()
    value = {}
    if parser.pos < len(parser.text):
        if parser.text[parser.pos] != ",":
            raise ValueError("unexpected MI record suffix")
        parser.pos += 1
        value = parser.fields()
    return Record(token, kind, name, value)


class MIClient:
    """Serial MI commands with bounded waits; preserve out-of-band stop and output records.

    Callers must close the client (or use a context manager) even after timeouts. On Windows,
    GDB may write the inferior's stdout directly into its MI stdout pipe, without an MI
    target-stream prefix or a newline before the next MI record.
    """

    def __init__(self, executable: str = "gdb", *, timeout: float = 10) -> None:
        self.process = subprocess.Popen(
            [executable, "--interpreter=mi3", "--quiet", "--nx"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            start_new_session=sys.platform != "win32",
            creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0),
        )
        self.timeout = timeout
        self.sequence = 0
        self.records: queue.Queue[str | None] = queue.Queue()
        self.carry: list[str] = []
        self.output_exceeded = False
        self._watch_stop = threading.Event()
        assert self.process.stdout is not None
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self.process.stdout is not None
        try:
            for line in self.process.stdout:
                self.records.put(line)
        finally:
            self.records.put(None)

    def read(self, deadline: float) -> Record:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("GDB MI response deadline exceeded")
        try:
            line = self.carry.pop() if self.carry else self.records.get(timeout=remaining)
        except queue.Empty as error:
            raise TimeoutError("GDB MI response deadline exceeded") from error
        if line is None:
            raise RuntimeError("GDB exited before replying")
        # A Windows inferior can print "42" immediately before GDB's "=library-loaded".
        # That is not MI token 42; recover the observed output before parsing the record.
        marker = re.search(
            r"(?:\d+\^|[~@&*+=])(?:done|running|stopped|error|exit|"
            r"thread-|library-|thread-group-|breakpoint-|\")",
            line,
        )
        if marker and marker.start():
            self.carry.append(line[marker.start() :])
            return Record(None, "@", None, line[: marker.start()])
        try:
            record = parse_record(line)
        except ValueError:
            if line[:1] in "^*+=~@&":
                raise
            return Record(None, "@", None, line)
        return record if record is not None else self.read(deadline)

    def command(self, instruction: str) -> tuple[Record, list[Record]]:
        """Issue one MI instruction and return its result with preceding async records."""
        if "\n" in instruction or "\r" in instruction:
            raise ValueError("MI commands must be a single line")
        self.sequence += 1
        assert self.process.stdin is not None
        self.process.stdin.write(f"{self.sequence}{instruction}\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + self.timeout
        pending: list[Record] = []
        while True:
            record = self.read(deadline)
            if record.kind == "^" and record.token == self.sequence:
                return record, pending
            pending.append(record)

    def stop(self, deadline: float | None = None) -> tuple[Record, list[Record]]:
        """Wait for an observed inferior stop, collecting output and notifications along the way."""
        end = deadline if deadline is not None else time.monotonic() + self.timeout
        pending: list[Record] = []
        while True:
            record = self.read(end)
            if record.kind == "*" and record.name == "stopped":
                return record, pending
            pending.append(record)

    def watch_output(self, paths: tuple[Path, Path], limit: int) -> None:
        """Stop a noisy inferior before redirected stdout/stderr exhaust the disk."""
        ceiling = max(65536, limit)

        def supervise() -> None:
            while not self._watch_stop.wait(0.02) and self.process.poll() is None:
                try:
                    used = sum(path.stat().st_size for path in paths if path.is_file())
                except OSError:
                    continue
                if used <= ceiling:
                    continue
                self.output_exceeded = True
                if sys.platform == "win32":
                    subprocess.run(
                        ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                        capture_output=True,
                        timeout=5,
                        check=False,
                    )
                else:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(self.process.pid, signal.SIGKILL)
                return

        threading.Thread(target=supervise, daemon=True).start()

    def close(self) -> None:
        self._watch_stop.set()
        if self.process.poll() is None:
            try:
                assert self.process.stdin is not None
                self.process.stdin.write(f"{self.sequence + 1}-gdb-exit\n")
                self.process.stdin.flush()
                self.process.wait(timeout=2)
            except (OSError, AssertionError, subprocess.TimeoutExpired):
                if sys.platform == "win32":
                    subprocess.run(
                        ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                        capture_output=True,
                        timeout=5,
                        check=False,
                    )
                else:
                    os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=5)
        if self.process.stdin is not None:
            self.process.stdin.close()
        if self.process.stdout is not None:
            self.process.stdout.close()

    def __enter__(self) -> MIClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
