#!/usr/bin/env bash
#
# Everything, checked against everything.
#
# The individual suites each prove one thing. This runs the whole lot in the order that catches the
# most: artifacts before the code that depends on them, adapters before the traces they produce,
# traces before the suites that replay them, and the browser last because it can only be trusted once
# the rest holds.
#
# Reports a line per check and a tally. Non-zero exit if anything failed.
#
# Usage: scripts/cross-verify.sh [--skip-browser]

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/_env.sh
source "$ROOT/scripts/_env.sh"
cd "$ROOT"

SKIP_BROWSER=0
[ "${1:-}" = "--skip-browser" ] && SKIP_BROWSER=1

PASSED=0
FAILED=0
declare -a FAILURES=()

run() {
  local label="$1"; shift
  local log
  log="$(mktemp)"
  if "$@" >"$log" 2>&1; then
    printf '  \033[32mok\033[0m    %-34s %s\n' "$label" "$(summarise "$log")"
    PASSED=$((PASSED + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-34s\n' "$label"
    sed 's/^/          /' "$log" | tail -12
    FAILED=$((FAILED + 1))
    FAILURES+=("$label")
  fi
  rm -f "$log"
}

summarise() {
  grep -ohE '[0-9]+ (passed|tests?|cases?|files?)|[0-9]+/[0-9]+ passed|artifacts current|built in [0-9.]+m?s' "$1" \
    | tail -1 | tr -d '\n'
}

heading() { printf '\n\033[1m%s\033[0m\n' "$1"; }

PY="$PYTHON"
export PYTHONPATH="$ROOT/packages/trace-schema/python:$ROOT/adapters/python:$ROOT/apps/server"

heading "1. the contract"
run "schema artifacts are current" pnpm schema:check
run "generated types match the model" "$PY" packages/trace-schema/generate.py --check

heading "2. python"
run "schema validator" "$PY" -m pytest packages/trace-schema/python/tests -q
run "tracer" "$PY" -m pytest adapters/python/tests -q
run "server" "$PY" -m pytest apps/server/tests -q
run "backend agreement" "$PY" -m pytest conformance/tests -q

heading "3. the adapter against the corpus"
run "conformance corpus" "$PY" conformance/runner.py
run "settrace vs monitoring" "$PY" conformance/backends.py

heading "4. types and builds"
run "packages typecheck and build" npx tsc -b packages/renderers packages/trace-fixtures
run "web app typechecks" bash -c 'cd apps/web && pnpm exec tsc -b'
run "web app builds" bash -c 'cd apps/web && pnpm exec vite build'

heading "5. typescript"
run "every suite" pnpm vitest run

heading "6. source hygiene"
run "no leftover debugging" bash -c '
  ! grep -rn --include="*.ts" --include="*.tsx" --include="*.py" \
      -E "console\.log\(|breakpoint\(\)|import pdb|FIXME|XXX:" \
      adapters apps packages conformance scripts 2>/dev/null \
    | grep -v "generated/" | grep -v node_modules | grep -v "\.venv"'
run "no unintended non-ascii" bash -c '
  # Built output mirrors its sources, so only sources are checked. Typographic characters used
  # deliberately in prose are allowed; anything else is usually a slip.
  found=$(grep -rhoP "[^\x00-\x7F]" --include="*.py" --include="*.ts" --include="*.tsx" \
            adapters/python apps/web/src apps/server/flow_view_server packages/*/src conformance 2>/dev/null \
          | grep -v "[—µ×→·≥≤…’]" | sort -u)
  [ -z "$found" ] || { echo "unexpected characters: $found"; exit 1; }'
run "no unresolved task markers in specs" bash -c '
  ! grep -rn "TODO(" .kiro/specs docs 2>/dev/null'

if [ "$SKIP_BROWSER" -eq 0 ]; then
  heading "7. in a real browser"
  # The harness first. Everything below reports through it, and it has been wrong before: a click
  # that missed its target printed success, and an error count was read from a variable nothing set.
  run "the harness can fail" bash scripts/verify-harness.sh cv-harness
  run "fixtures step forward and back" bash scripts/verify-ui.sh cv-ui
  run "a live run traces end to end" bash scripts/verify-live.sh cv-live
  run "structures are recognised" bash scripts/verify-heap.sh cv-heap
  run "a program explains itself" bash scripts/verify-narration.sh cv-narr
else
  heading "7. in a real browser"
  echo "  skipped"
fi

heading "8. repository"
run "working tree is clean" bash -c '[ -z "$(git status --porcelain)" ]'
# Compare against whatever this branch tracks, not against main. Hardcoding origin/main meant the
# check could only ever pass on one branch, and quietly failed on every other for the wrong reason.
run "local matches its remote" bash -c '
  git fetch origin --quiet 2>/dev/null || true
  branch="$(git branch --show-current)"
  remote="$(git rev-parse "origin/$branch" 2>/dev/null || echo none)"
  if [ "$remote" = "none" ]; then
    echo "origin/$branch does not exist yet - push the branch"
    exit 1
  fi
  [ "$(git rev-parse HEAD)" = "$remote" ] || {
    echo "HEAD and origin/$branch differ"; exit 1; }'

printf '\n\033[1m%s\033[0m\n' "result"
printf '  %d passed, %d failed\n' "$PASSED" "$FAILED"
if [ "$FAILED" -gt 0 ]; then
  printf '  failed: %s\n' "${FAILURES[*]}"
  exit 1
fi
printf '  everything checked out\n'
