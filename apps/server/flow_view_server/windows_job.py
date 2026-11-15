"""Best-effort Windows process-tree and committed-memory limits.

A Job Object can kill the supervised process and its descendants when the job handle is closed, and
bound each process's committed memory. Assignment happens immediately after asyncio spawns the child,
so there is a small startup race; this is an accidental-damage guard, not a hostile-code sandbox.
"""

from __future__ import annotations

import ctypes
import os
from ctypes import wintypes


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
    )]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimits),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class WindowsJob:
    """Own a Windows Job Object handle; closing it terminates every assigned process."""

    def __init__(self, handle: int, kernel: object) -> None:
        self._handle = handle
        self._kernel = kernel

    @classmethod
    def attach(cls, pid: int, memory_mb: int) -> WindowsJob | None:
        if os.name != "nt":
            return None
        try:
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        except OSError:
            return None
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ]
        kernel.SetInformationJobObject.restype = wintypes.BOOL
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL

        handle = kernel.CreateJobObjectW(None, None)
        if not handle:
            return None
        attached = False
        try:
            limits = _ExtendedLimits()
            # Kill descendants when the job closes. This is a committed-memory ceiling (not virtual
            # address space, which prevents V8 from starting even when it uses very little memory).
            limits.BasicLimitInformation.LimitFlags = 0x2000 | 0x100
            limits.ProcessMemoryLimit = max(1, memory_mb) * 1024 * 1024
            if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                return None
            process = kernel.OpenProcess(0x0100 | 0x0001, False, pid)
            if not process:
                return None
            try:
                if not kernel.AssignProcessToJobObject(handle, process):
                    return None
            finally:
                kernel.CloseHandle(process)
            attached = True
            return cls(handle, kernel)
        finally:
            # Ownership is transferred only if assignment succeeded. An abandoned job must not leak.
            if not attached:
                kernel.CloseHandle(handle)

    def close(self) -> None:
        handle, self._handle = self._handle, 0
        if handle:
            self._kernel.CloseHandle(handle)
