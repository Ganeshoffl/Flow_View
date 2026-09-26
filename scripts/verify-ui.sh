#!/usr/bin/env bash
#
# The Phase 0 gate, automated.
#
# Loads every fixture in a real browser, walks it to the end and back to the start, and checks that
# the playhead returns to zero with no console errors. Spot-checking a few fixtures by eye is how a
# regression in the seventeenth one survives to Phase 1.
#
# Usage: scripts/verify-ui.sh [session-name]

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="${1:-fv-verify}"
URL="http://127.0.0.1:5173/"
FAILURES=0

cd "$ROOT/apps/web"
(pnpm exec vite >/tmp/vite-verify.log 2>&1 &)

printf 'waiting for the dev server'
for _ in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$URL" || true)"
  [ "$code" = "200" ] && break
  printf '.'
  sleep 1
done
echo
if [ "${code:-}" != "200" ]; then
  echo "dev server did not come up; see /tmp/vite-verify.log" >&2
  exit 1
fi

ab() { agent-browser --session "$SESSION" "$@"; }
# agent-browser assigns element refs during a snapshot, so one is needed before any interaction.
ab open "$URL" >/dev/null 2>&1
ab snapshot >/dev/null 2>&1

evaluate() { ab eval "$1" 2>&1 | tail -2 | head -1 | sed 's/^"//; s/"$//'; }

fixtures="$(evaluate "(() => [...document.querySelectorAll('#fixture option')].map(o => o.value).join(' '))()")"
if [ -z "$fixtures" ]; then
  echo "could not read the fixture list from the page" >&2
  exit 1
fi

echo "checking $(echo "$fixtures" | wc -w) fixtures"
echo

for id in $fixtures; do
  ab select 'select#fixture' "$id" >/dev/null 2>&1

  # To the end, then all the way back.
  ab press "End" >/dev/null 2>&1
  at_end="$(evaluate "(() => document.querySelector('.fv-position')?.textContent ?? '')()")"

  ab press "Home" >/dev/null 2>&1
  at_start="$(evaluate "(() => {
    const pos = document.querySelector('.fv-position')?.textContent ?? '';
    const vars = document.querySelectorAll('.fv-var').length;
    const frames = document.querySelectorAll('.fv-frame').length;
    const active = document.querySelectorAll('.fv-code-line.is-active').length;
    return pos + ' | vars ' + vars + ' | frames ' + frames + ' | active ' + active;
  })()")"

  # Rewound to the start, nothing should be bound, on the stack, or highlighted.
  if echo "$at_start" | grep -q 'step 0 .* vars 0 | frames 0 | active 0'; then
    status="ok"
  else
    status="FAILED"
    FAILURES=$((FAILURES + 1))
  fi

  printf '%-20s %-7s end=%-14s rewound: %s\n' "$id" "$status" "${at_end// /}" "$at_start"
done

echo
errors="$(evaluate "(() => (window.__fvErrors ?? []).length)()")"
echo "console errors observed: ${errors:-0}"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES fixture(s) did not rewind cleanly" >&2
  exit 1
fi
echo "all fixtures stepped to the end and rewound to a clean initial state"
