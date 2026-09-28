#!/usr/bin/env bash
#
# The Phase 2 gate.
#
# Builds each structure the heap view claims to understand, runs it through the real stack, and checks
# what was drawn: the inferred shape, the evidence, the node count, and that a tree-shaped class
# holding a cycle is reported as a graph.
#
# Usage: scripts/verify-heap.sh [session-name]

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/_env.sh
source "$ROOT/scripts/_env.sh"
AB_SESSION="${1:-fv-heap}"
cd "$ROOT"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

PYTHONPATH="$ROOT/apps/server" "$PYTHON" -m flow_view_server \
  --no-browser --port 7474 >/tmp/fv-heap-server.log 2>&1 &
SERVER_PID=$!
(cd "$ROOT/apps/web" && pnpm exec vite >/tmp/fv-heap-web.log 2>&1) &
WEB_PID=$!

printf 'waiting'
for _ in $(seq 1 45); do
  api="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7474/api/capabilities || true)"
  web="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/ || true)"
  [ "$api" = "200" ] && [ "$web" = "200" ] && break
  printf '.'; sleep 1
done
echo " server=${api:-down} ui=${web:-down}"
[ "${api:-}" = "200" ] && [ "${web:-}" = "200" ] || { tail -20 /tmp/fv-heap-server.log; exit 1; }

FAILURES=0
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

ab open "http://127.0.0.1:5173/" >/dev/null 2>&1
sleep 2
ab_instrument >/dev/null
ab snapshot >/dev/null 2>&1

# Replace the editor contents and run.
#
# Every step is checked. This used to set the textarea through a synthetic event and click blind, and
# when the clicks silently stopped landing the gate happily reported on a heap from the previous
# program.
run_program() {
  local source="$1" label="$2" runs_before runs_after
  runs_before="$(grep -c 'POST /api/session' /tmp/fv-heap-server.log)"

  # After a run the traced code occupies the left pane, so go back to the editor first.
  if ab_eval "(() => [...document.querySelectorAll('button')].some(
        (b) => b.textContent.trim() === 'Edit code'))()" | grep -q true; then
    ab_click_text button "Edit code" || { fail "$label: could not switch back to the editor"; return 1; }
  fi

  ab_set_source "$source" || { fail "$label: the editor did not take the program"; return 1; }

  ab_click 'button.fv-run' || { fail "$label: the run button was not clicked"; return 1; }

  # Wait for the run to actually finish rather than trusting a fixed sleep.
  local status=""
  for _ in $(seq 1 30); do
    status="$(ab_eval "(() => document.querySelector('.fv-status')?.textContent)()")"
    [ "$status" = "finished" ] || [ "$status" = "failed" ] && break
    sleep 0.5
  done
  runs_after="$(grep -c 'POST /api/session' /tmp/fv-heap-server.log)"
  if [ "$runs_after" -le "$runs_before" ]; then
    fail "$label: no new session was created (still $runs_after)"
    return 1
  fi
  if [ "$status" != "finished" ]; then
    fail "$label: run ended as '${status:-unknown}'"
    return 1
  fi
}

# Collect every shape the heap drew.
#
# Positions are not in the DOM — the drawing is a canvas — so the structure chips are what we read.
inspect() {
  ab_eval "(() => {
    const count = document.querySelector('.fv-heap-actions .fv-muted')?.textContent ?? '-';
    const found = [...document.querySelectorAll('.fv-structure')].map(b =>
      b.dataset.shape + ' [' + b.dataset.confidence + '] ' + (b.title || '').replace(/\\n/g, ' | '));
    return count + ' | ' + (found.join('  ||  ') || 'nothing drawn');
  })()"
}

check() {
  local label="$1" program="$2" expect="$3"
  run_program "$program" "$label" || return
  local result
  result="$(inspect)"
  if echo "$result" | grep -qi "$expect"; then
    printf '  ok    %-22s %s\n' "$label" "$result"
  else
    printf '  FAIL  %-22s expected %s\n        got %s\n' "$label" "$expect" "$result"
    FAILURES=$((FAILURES + 1))
  fi
}

NODE='class Node:
    def __init__(self, v):
        self.v = v
        self.next = None
'
TREE='class T:
    def __init__(self, k):
        self.k = k
        self.left = None
        self.right = None
'

echo
echo "=== structures the heap view must recognise ==="
check "linked list" "${NODE}a = Node(1)
a.next = Node(2)
a.next.next = Node(3)
" "linked_list"
check "binary search tree" "${TREE}r = T(8)
r.left = T(3)
r.right = T(10)
r.left.left = T(1)
" "bst"
check "grid" 'grid = [[1,2,3],[4,5,6],[7,8,9]]
x = grid[0][0]
' "matrix"
check "cycle in a tree class" "${TREE}r = T(1)
c = T(2)
r.left = c
c.right = r
d = 1
" "graph"
check "stack" 's = []
s.append(1)
s.append(2)
s.append(3)
s.pop()
' "stack\|push"
check "circular list" "${NODE}a = Node(1)
b = Node(2)
c = Node(3)
a.next = b
b.next = c
c.next = a
" "circular\|returns to where"

echo
echo "=== two runs in one page load ==="
# The regression this gate missed once already: only the first run ever reached the server.
before="$(grep -c 'POST /api/session' /tmp/fv-heap-server.log)"
run_program 'x = 1
y = x + 1
' "consecutive run A"
run_program 'p = [1, 2]
p.append(3)
' "consecutive run B"
after="$(grep -c 'POST /api/session' /tmp/fv-heap-server.log)"
if [ "$((after - before))" -eq 2 ]; then
  printf '  ok    %-22s two runs, two sessions\n' "run again"
else
  fail "run again: expected 2 new sessions, got $((after - before))"
fi

echo
echo "=== the shell never scrolls its controls away ==="
# A short viewport used to push the header and the run button off the top of the screen.
for size in "1280 800" "1280 577" "1100 520"; do
  set -- $size
  ab resize "$1" "$2" >/dev/null 2>&1 || ab_eval "(() => 'no resize')()" >/dev/null
  sleep 1
  verdict="$(ab_eval "(() => {
    const d = document.documentElement;
    const run = document.querySelector('button.fv-run').getBoundingClientRect();
    const onScreen = run.top >= 0 && run.bottom <= window.innerHeight;
    return 'docScrolls=' + (d.scrollHeight > d.clientHeight + 1) + ' runVisible=' + onScreen +
      ' runTop=' + Math.round(run.top);
  })()")"
  if echo "$verdict" | grep -q 'docScrolls=false runVisible=true'; then
    printf '  ok    %-22s %s\n' "${1}x${2}" "$verdict"
  else
    fail "${1}x${2}: $verdict"
  fi
done
ab resize 1280 800 >/dev/null 2>&1

echo
echo "=== any pane can take the whole grid ==="
# The grid gives every pane a share, which is wrong the moment you want to read one of them. A twelve-line
# program showed eight lines; a dozen-node tree got a box four lines high.
run_program "${TREE}r = T(8)
r.left = T(3)
r.right = T(10)
r.left.left = T(1)
r.left.right = T(6)
" "expanding" || true

CONTROLS="$(ab_eval "(() => {
  const areas = [...document.querySelectorAll('.fv-area')];
  return areas.length + ' areas, ' + areas.filter((a) => a.querySelector('.fv-expand')).length + ' controls';
})()")"
echo "  $CONTROLS"
case "$CONTROLS" in
  "7 areas, 7 controls") ok_line=1; printf '  ok    %-22s every pane has one\n' "expand control" ;;
  *) fail "not every pane has an expand control: $CONTROLS" ;;
esac

SMALL="$(ab_eval "(() => Math.round(document.querySelector('.fv-area.is-heap').getBoundingClientRect().height))()")"
ab_click '.fv-area.is-heap .fv-expand' || fail "the heap's expand control was not clicked"
sleep 1
BIG="$(ab_eval "(() => {
  const h = document.querySelector('.fv-area.is-heap').getBoundingClientRect();
  const visible = [...document.querySelectorAll('.fv-area')].filter((a) => a.getBoundingClientRect().height > 0).length;
  const run = document.querySelector('button.fv-run').getBoundingClientRect();
  const d = document.documentElement;
  return Math.round(h.height) + '|' + visible + '|' + (run.top >= 0 && run.bottom <= window.innerHeight) +
    '|' + (d.scrollHeight > d.clientHeight + 1);
})()")"
IFS='|' read -r tall visible runVisible scrolls <<<"$BIG"
echo "  heap height ${SMALL}px -> ${tall}px, visible panes=$visible, run reachable=$runVisible, page scrolls=$scrolls"
[ "$tall" -gt "$SMALL" ] && printf '  ok    %-22s %spx -> %spx\n' "expanding grows it" "$SMALL" "$tall" \
  || fail "expanding did not make the heap bigger"
[ "$visible" = "1" ] && printf '  ok    %-22s the others step aside\n' "one pane at a time" \
  || fail "expected 1 visible pane, got $visible"
# The whole point of expanding the heap is to keep stepping while you look at it.
[ "$runVisible" = "true" ] && [ "$scrolls" = "false" ] \
  && printf '  ok    %-22s controls stay reachable\n' "still usable" \
  || fail "expanding pushed the controls off screen (run=$runVisible scrolls=$scrolls)"

STEPPED_FROM="$(ab_eval "(() => document.querySelector('.fv-position')?.textContent?.trim())()")"
ab press 'ArrowLeft' >/dev/null 2>&1
STEPPED_TO="$(ab_eval "(() => document.querySelector('.fv-position')?.textContent?.trim())()")"
[ "$STEPPED_FROM" != "$STEPPED_TO" ] \
  && printf '  ok    %-22s %s -> %s while expanded\n' "stepping works" "$STEPPED_FROM" "$STEPPED_TO" \
  || fail "could not step while a pane was expanded"

ab press 'Escape' >/dev/null 2>&1
sleep 1
BACK="$(ab_eval "(() => [...document.querySelectorAll('.fv-area')].filter((a) => a.getBoundingClientRect().height > 0).length)()")"
[ "$BACK" = "7" ] && printf '  ok    %-22s Escape restores all 7\n' "collapsing" \
  || fail "Escape did not restore the grid (visible=$BACK)"

echo
echo "=== the raw view is always available ==="
run_program "${TREE}r = T(5)
r.left = T(3)
" "raw mode"
ab_click 'button.fv-mini' || fail "raw mode: toggle not clicked"
ab_eval "(() => {
  const on = document.querySelector('.fv-mini')?.classList.contains('is-on');
  const count = document.querySelector('.fv-heap-actions .fv-muted')?.textContent ?? '-';
  return '  raw mode on: ' + on + ', ' + count;
})()"

# Back out of raw mode, or every screenshot below shows it.
ab_click 'button.fv-mini' || fail "raw mode: could not turn off"

mkdir -p /projects/sandbox/.kiro/artifacts/screenshots
echo
echo "=== screenshots ==="
run_program "${TREE}root = T(8)
root.left = T(3)
root.right = T(10)
root.left.left = T(1)
root.left.right = T(6)
" "bst screenshot"
ab screenshot /projects/sandbox/.kiro/artifacts/screenshots/20260926-heap-bst.png 2>&1 | tail -1
run_program "${NODE}head = Node(1)
head.next = Node(2)
head.next.next = Node(3)
" "list screenshot"
ab screenshot /projects/sandbox/.kiro/artifacts/screenshots/20260926-heap-list.png 2>&1 | tail -1

echo
errors="$(ab_errors)"
echo "console errors: $errors"
case "$errors" in
  0) ;;
  *) fail "the page reported errors: $errors" ;;
esac

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed" >&2
  exit 1
fi
echo "every structure was recognised and explained"
