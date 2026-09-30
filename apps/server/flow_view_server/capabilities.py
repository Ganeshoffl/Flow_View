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


#: The oldest Node that can run the adapter. It uses `--permission`, which arrived in 20 and is the only
#: sandbox node offers; on anything older a run would work but be unguarded, and silently so.
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
                "the permission model that sandboxes a run."
            ),
            remedy=f"Upgrade to Node {MINIMUM_NODE_MAJOR} or newer.",
        )

    if javascript_adapter_root() is None:
        return LanguageSupport(
            language="javascript",
            available=False,
            version=version,
            reason="The JavaScript adapter is not installed alongside this server.",
            remedy="Run flow_view from a checkout, where adapters/javascript is present.",
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

    has_gcc = shutil.which("gcc") or shutil.which("cc")
    has_gpp = shutil.which("g++") or shutil.which("clang++")
    gdb = shutil.which("gdb")
    for language, compiler in (("c", has_gcc), ("cpp", has_gpp)):
        missing: list[str] = []
        if not compiler:
            missing.append("a C compiler" if language == "c" else "a C++ compiler")
        if not gdb:
            missing.append("gdb")
        support.append(
            LanguageSupport(
                language=language,
                available=False,
                version=_tool_version([compiler, "--version"]) if compiler else None,
                reason=(
                    f"Missing {' and '.join(missing)}." if missing
                    else "The C/C++ adapter is not built yet."
                ),
                remedy=(
                    "Install gdb, for example `sudo dnf install gdb` or `sudo apt install gdb`."
                    if not gdb
                    else None
                ),
                planned="phase 8",
            )
        )

    support.append(_java_support())

    return tuple(support)


#: The oldest Java that can run the adapter. It is written in modern Java — records, switch expressions,
#: pattern matching for `instanceof` — and needs a compiler that understands them.
MINIMUM_JAVA_MAJOR = 21


def _java_support() -> LanguageSupport:
    """Whether Java can actually be traced here.

    Three separate things, with three different remedies: a **JDK** rather than a JRE, because tracing needs
    both `javac` to compile the program and `jdk.jdi` to drive it; a recent enough one; and the adapter itself.
    """
    from .runner import java_adapter_source

    java = shutil.which("java")
    javac = shutil.which("javac")
    if java is None or javac is None:
        missing = "Java" if java is None else "the Java compiler"
        return LanguageSupport(
            language="java",
            available=False,
            reason=(
                f"Missing {missing}. Tracing Java needs a JDK rather than a JRE: the program is compiled "
                "with javac and then driven through the JVM's own debug interface."
            ),
            remedy=f"Install a JDK {MINIMUM_JAVA_MAJOR} or newer, for example `sudo apt install default-jdk`.",
        )

    # `java -version` writes to stderr, which `_tool_version` already reads. It writes a whole sentence —
    # `openjdk version "25.0.2" 2026-01-20` — where every other language reports a bare version, so the number is
    # pulled out of it. The UI puts this straight into a badge beside the Run button, and the unabridged line
    # spilled across it.
    version = _version_number(_tool_version([java, "-version"]))
    major = _major_version(version)
    if major is not None and major < MINIMUM_JAVA_MAJOR:
        return LanguageSupport(
            language="java",
            available=False,
            version=version,
            reason=f"Java {major} is too old: the adapter needs {MINIMUM_JAVA_MAJOR} or newer.",
            remedy=f"Install a JDK {MINIMUM_JAVA_MAJOR} or newer.",
        )

    if java_adapter_source() is None:
        return LanguageSupport(
            language="java",
            available=False,
            version=version,
            reason="The Java adapter is not installed alongside this server.",
            remedy="Run flow_view from a checkout, where adapters/java is present.",
        )

    return LanguageSupport(language="java", available=True, version=version)


def _version_number(reported: str | None) -> str | None:
    """The version out of a line like `openjdk version "25.0.2" 2026-01-20`."""
    if not reported:
        return None
    start = reported.find('"')
    if start >= 0:
        end = reported.find('"', start + 1)
        if end > start:
            return reported[start + 1 : end]
    # Some builds print it bare. Take the first thing that starts with a digit.
    for word in reported.split():
        if word and word[0].isdigit():
            return word
    return None


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
