"""What this machine can actually trace.

A missing toolchain must never break flow_view. It disables exactly one language, with a message
that says what is missing and how to get it — not a stack trace at run time, and not a language that
appears to work and then fails.

Detection is cached, because probing five toolchains on every request would make the UI slow for no
benefit; a toolchain does not appear or vanish mid-session.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from functools import lru_cache

__all__ = ["LanguageSupport", "capabilities", "language_support"]


@dataclass
class LanguageSupport:
    """Whether one language can be traced here."""

    language: str
    available: bool
    version: str | None = None
    #: What is missing, in plain words.
    reason: str | None = None
    #: How to fix it. Shown verbatim to the user.
    remedy: str | None = None
    #: The phase that will implement it, when the answer is "not yet".
    planned: str | None = None


def _tool_version(command: list[str]) -> str | None:
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell
            command,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    output = (result.stdout or result.stderr or "").strip()
    return output.splitlines()[0] if output else None


#: The oldest Node that can run the adapter. It uses `--permission`, which arrived in 20 and is the
#: best-effort filesystem/child-process guard; it does not restrict networking.
MINIMUM_NODE_MAJOR = 20


def _javascript_support() -> LanguageSupport:
    """Whether JavaScript can actually be traced here.

    Two separate things have to be true, and the old entry conflated them: node has to be installed, and the
    adapter has to be present. It reported "the adapter is not built yet" even on a machine with no node at
    all, which is the wrong remedy for that machine.
    """
    from .runner import javascript_adapter_root

    node = shutil.which("node")
    if node is None:
        return LanguageSupport(
            language="javascript",
            available=False,
            reason="Node.js is not installed, or not on PATH.",
            remedy=f"Install Node {MINIMUM_NODE_MAJOR} or newer, then restart flow_view.",
        )

    version = _tool_version([node, "--version"])
    major = _major_version(version)
    if major is not None and major < MINIMUM_NODE_MAJOR:
        return LanguageSupport(
            language="javascript",
            available=False,
            version=version,
            reason=(
                f"Node {version} is too old: tracing JavaScript needs {MINIMUM_NODE_MAJOR} or newer for "
                "the permission model used for best-effort process and file guards."
            ),
            remedy=f"Upgrade to Node {MINIMUM_NODE_MAJOR} or newer.",
        )

    if javascript_adapter_root() is None:
        return LanguageSupport(
            language="javascript",
            available=False,
            version=version,
            reason="The JavaScript adapter is not installed alongside this server.",
            remedy="Reinstall a wheel containing the JavaScript bundle, or build from a checkout.",
        )

    return LanguageSupport(language="javascript", available=True, version=version)


def _major_version(version: str | None) -> int | None:
    """The major number out of something like `v22.23.2`, or None if it does not look like one."""
    if not version:
        return None
    digits = ""
    for char in version.lstrip("v"):
        if not char.isdigit():
            break
        digits += char
    return int(digits) if digits else None


def _native_support(language: str, compiler_name: str) -> LanguageSupport:
    """Only enable a native language when its CLI, compiler, and debugger exist."""
    from .runner import c_adapter_cli

    compiler = shutil.which(compiler_name)
    gdb = shutil.which("gdb")
    cli = c_adapter_cli()
    label = "C++" if language == "cpp" else "C"
    missing: list[str] = []
    remedies: list[str] = []
    if not compiler:
        missing.append(f"the {compiler_name.upper() if language == 'c' else 'G++'} {label} compiler")
        remedies.append(f"Install {compiler_name.upper() if language == 'c' else 'G++'} and put {compiler_name} on PATH.")
    if not gdb:
        missing.append("GDB")
        remedies.append("Install GDB and put gdb on PATH (for example, `sudo apt install gdb`).")
    if cli is None:
        missing.append("the compiled-debug native adapter CLI")
        remedies.append("Install a build containing the native adapter CLI, or run from a checkout.")
    version = _tool_version([compiler, "--version"]) if compiler else None
    if missing:
        return LanguageSupport(language=language, available=False, version=version,
                               reason=f"Missing {', '.join(missing)}.", remedy=" ".join(remedies),
                               planned="phase 8" if cli is None else None)
    return LanguageSupport(language=language, available=True, version=version)


def _c_support() -> LanguageSupport:
    return _native_support("c", "gcc")


def _cpp_support() -> LanguageSupport:
    return _native_support("cpp", "g++")


@lru_cache(maxsize=1)
def language_support() -> tuple[LanguageSupport, ...]:
    """Probe every language flow_view knows about."""
    support: list[LanguageSupport] = [
        LanguageSupport(
            language="python",
            available=True,
            version=".".join(str(part) for part in sys.version_info[:3]),
        )
    ]

    support.append(_javascript_support())
    support.append(_c_support())
    support.append(_cpp_support())

    java = shutil.which("javac")
    support.append(
        LanguageSupport(
            language="java",
            available=False,
            version=_tool_version([java, "-version"]) if java else None,
            reason="Missing a JDK." if not java else "The Java adapter is not built yet.",
            remedy="Install a JDK, for example `sudo apt install default-jdk`." if not java else None,
            planned="phase 9",
        )
    )

    return tuple(support)


def capabilities() -> dict[str, object]:
    """The payload served at ``/api/capabilities``."""
    from .runner import platform_guards

    guards = platform_guards()
    return {
        "languages": [asdict(item) for item in language_support()],
        "guards": guards,
        # Stated plainly so the UI never has to imply a protection that is not in force.
        "inactive_guards": [name for name, active in guards.items() if not active],
        "profile": "full",
        "platform": sys.platform,
    }
