#!/usr/bin/env python3
"""Finding debugging left behind in the project's own code.

A plain `grep -rn "console.log("` was enough while everything here was Python and TypeScript. It stopped
being enough the moment JavaScript became a language flow_view *traces*, because `console.log` is now three
different things depending on where it appears:

- **Code**: a stray print in the adapter or the UI. This is what the check is for.
- **Data**: a sample program written as a string in a test, or the starter program offered in the editor.
  `console.log` is how a JavaScript program produces output — a corpus of JavaScript programs that never
  printed anything would test nothing.
- **Prose**: a comment explaining that `print(None)` writes "None" where `console.log(null)` writes "null".

The grep found eight of the second and third kinds and none of the first, and — worse — never looked at
`.js` at all, so the one place a stray `console.log` would really matter was the one place unchecked.

So this strips string literals and comments first, and reports what is left. That way the check gets
stricter and quieter at the same time: it now covers the JavaScript adapter, and it stops objecting to
programs for being programs.

Usage:  _hygiene.py <root> [<root> ...]
Exits 1 and prints every offending line when anything is found.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

#: Debugging that only counts as debugging when it is code.
#:
#: Matched against the text with strings and comments blanked out, because a sample program that prints is
#: doing its job and a comment about printing is documentation.
IN_CODE = (
    (re.compile(r"\bconsole\.log\s*\("), "console.log"),
    (re.compile(r"\bbreakpoint\s*\(\s*\)"), "breakpoint()"),
    (re.compile(r"\bimport\s+pdb\b"), "import pdb"),
)

#: Markers that live in comments by definition.
#:
#: Matched against the raw text. Blanking comments first — as an earlier version of this did — left these two
#: patterns unable to match anything at all: a check that had quietly stopped checking, which is the failure
#: mode this whole file exists to avoid.
ANYWHERE = (
    (re.compile(r"\bFIXME\b"), "FIXME"),
    (re.compile(r"\bXXX:"), "XXX:"),
)

SUFFIXES = {".py", ".ts", ".tsx", ".js"}

#: Directories excluded, and why.
#:
#: `conformance/cases` holds programs in the languages flow_view traces. Their whole purpose is to run and
#: print, so a rule against printing cannot apply to them. Everything else here is either generated,
#: vendored, or build output — code nobody wrote by hand and nobody will read.
SKIP_PARTS = {
    "node_modules",
    ".venv",
    "dist",
    "generated",
    "__pycache__",
    ".traces",
}
SKIP_DIRS = (Path("conformance") / "cases",)

#: This file, which cannot define the markers it forbids without containing them.
#:
#: The only exemption here, and narrow on purpose: a general "ignore this line" escape hatch would turn a
#: check into a suggestion.
SELF = Path(__file__).name


def blanked(text: str, suffix: str) -> str:
    """The same text with string literals and comments replaced by spaces.

    Spaces rather than removal, so a match's column still points at the right place in the real line. The
    scan is character by character because a regex cannot tell a quote inside a comment from one that opens
    a string, and getting that backwards would either hide real findings or invent them.
    """
    out = []
    index = 0
    length = len(text)
    python = suffix == ".py"

    while index < length:
        char = text[index]
        rest = text[index:]

        # Comments run to the end of the line.
        if (python and char == "#") or (not python and rest.startswith("//")):
            while index < length and text[index] != "\n":
                out.append(" ")
                index += 1
            continue

        # Block comments, which may span lines. Newlines are kept so line numbers hold.
        if not python and rest.startswith("/*"):
            while index < length and not text[index:].startswith("*/"):
                out.append("\n" if text[index] == "\n" else " ")
                index += 1
            out.append("  ")
            index += 2
            continue

        # Triple-quoted Python strings, including docstrings.
        if python and (rest.startswith('"""') or rest.startswith("'''")):
            fence = rest[:3]
            out.append("   ")
            index += 3
            while index < length and not text[index:].startswith(fence):
                out.append("\n" if text[index] == "\n" else " ")
                index += 1
            out.append("   ")
            index += 3
            continue

        # Ordinary strings. Template literals in JavaScript may contain newlines.
        if char in "\"'" or (not python and char == "`"):
            fence = char
            out.append(" ")
            index += 1
            while index < length:
                if text[index] == "\\":
                    out.append("  ")
                    index += 2
                    continue
                if text[index] == fence:
                    out.append(" ")
                    index += 1
                    break
                if text[index] == "\n" and fence != "`":
                    # An unterminated single-line string. Stop rather than swallowing the rest of the file.
                    break
                out.append("\n" if text[index] == "\n" else " ")
                index += 1
            continue

        out.append(char)
        index += 1

    return "".join(out)


def should_skip(path: Path) -> bool:
    if path.name == SELF:
        return True
    if any(part in SKIP_PARTS for part in path.parts):
        return True
    return any(skip in path.parents for skip in SKIP_DIRS)


def main(argv: list[str]) -> int:
    roots = [Path(arg) for arg in argv] or [Path(".")]
    findings: list[str] = []

    for root in roots:
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.suffix not in SUFFIXES or should_skip(path):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue

            raw_lines = text.split("\n")
            code_lines = blanked(text, path.suffix).split("\n")

            for number, line in enumerate(code_lines, start=1):
                for pattern, label in IN_CODE:
                    if pattern.search(line):
                        original = raw_lines[number - 1].strip()
                        findings.append(f"{path}:{number}: {label}  |  {original[:120]}")

            for number, line in enumerate(raw_lines, start=1):
                for pattern, label in ANYWHERE:
                    if pattern.search(line):
                        findings.append(f"{path}:{number}: {label}  |  {line.strip()[:120]}")

    for finding in findings:
        print(finding)
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
