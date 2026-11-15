"""Real Windows Job Object behavior, rather than mocking the API and guessing its semantics."""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys

import pytest

from flow_view_server.windows_job import WindowsJob

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows Job Objects only exist on Windows")


def test_job_limits_committed_process_memory() -> None:
    program = (
        "import sys\nsys.stdin.buffer.read(1)\n"
        "try:\n bytearray(128 * 1024 * 1024)\n print('allocated')\n"
        "except MemoryError:\n print('limited')\n"
    )
    process = subprocess.Popen(
        [sys.executable, "-I", "-u", "-c", program],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    job = WindowsJob.attach(process.pid, 64)
    try:
        assert job is not None, "this machine did not accept the Job Object memory limit"
        stdout, _ = process.communicate(input=b"x", timeout=10)
        assert b"allocated" not in stdout, "the program allocated beyond its 64 MB ceiling"
    finally:
        if job is not None:
            job.close()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)


def test_closing_job_reaps_process_and_descendant() -> None:
    program = (
        "import subprocess, sys, time\n"
        "sys.stdin.buffer.read(1)\n"
        "child = subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(30)'])\n"
        "print(child.pid, flush=True)\n"
        "time.sleep(30)\n"
    )
    process = subprocess.Popen(
        [sys.executable, "-I", "-u", "-c", program],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    job = WindowsJob.attach(process.pid, 128)
    child_pid: int | None = None
    try:
        assert job is not None, "the process was not assigned to the Job Object"
        assert process.stdin is not None
        process.stdin.write(b"x")
        process.stdin.flush()
        assert process.stdout is not None
        child_pid = int(process.stdout.readline().strip())
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel.WaitForSingleObject.restype = ctypes.c_ulong
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        child = kernel.OpenProcess(0x00100000, False, child_pid)
        assert child
        try:
            job.close()
            process.wait(timeout=5)
            assert kernel.WaitForSingleObject(child, 5000) == 0, "a child survived its session"
        finally:
            kernel.CloseHandle(child)
    finally:
        if job is not None:
            job.close()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        if child_pid is not None:
            # Defensive cleanup if the assertion fails before the job handle can close.
            subprocess.run(["taskkill", "/PID", str(child_pid), "/F"], capture_output=True, check=False)
