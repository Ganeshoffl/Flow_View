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

    node = shutil.which("node")
    support.append(
        LanguageSupport(
            language="javascript",
            available=False,
            version=_tool_version([node, "--version"]) if node else None,
            reason="The JavaScript adapter is not built yet.",
            planned="phase 7",
        )
    )

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
