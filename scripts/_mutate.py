"""Apply one textual mutation to a file, for scripts/verify-fixes.sh.

A separate file rather than a heredoc because the heredoc had to be nested inside another one, and the
inner delimiter terminated the outer. Exits 3 when the text to replace is absent, which is the signal
the caller needs: a mutation that no longer applies means the code moved and the check is stale, which
is a different problem from a mutation that survived.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    path = os.environ["FV_FILE"]
    old = os.environ["FV_OLD"]
    new = os.environ["FV_NEW"]

    with open(path, encoding="utf-8") as handle:
        source = handle.read()

    if old not in source:
        print(f"    mutation does not apply: {old[:70]!r} not found in {path}", file=sys.stderr)
        return 3

    with open(path, "w", encoding="utf-8") as handle:
        handle.write(source.replace(old, new, 1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
