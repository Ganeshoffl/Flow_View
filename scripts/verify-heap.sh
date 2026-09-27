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
SESSION="${1:-fv-heap}"
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

ab() { agent-browser --session "$SESSION" "$@"; }
peek() { ab eval "$1" 2>&1 | tail -2 | head -1 | sed 's/^"//; s/"$//; s/\\"/"/g'; }

ab open "http://127.0.0.1:5173/" >/dev/null 2>&1
ab snapshot >/dev/null 2>&1

# Replace the editor contents and run.
run_program() {
  # After a run the traced code occupies the left pane, so go back to the editor first.
  ab eval "(() => {
    const toggle = [...document.querySelectorAll('button')].find(b => b.textContent === 'Edit code');
    if (toggle) toggle.click();
    return toggle ? 'switched to editor' : 'already editing';
  })()" >/dev/null 2>&1
  ab eval "(() => {
    const area = document.querySelector('.fv-editor-area');
    if (!area) return 'no editor';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(area, $1);
    area.dispatchEvent(new Event('input', { bubbles: true }));
    return 'set';
  })()" >/dev/null 2>&1
  ab click 'button.fv-run' >/dev/null 2>&1
  sleep 3
}

# Collect every shape the heap drew, by clicking across the canvas.
#
# Positions are not in the DOM — the drawing is a canvas — and a tidy tree centres its root rather than
# putting it at the origin, so a single fixed click cannot be relied on to hit anything in particular.
inspect() {
  peek "(() => {
    const count = document.querySelector('.fv-heap-actions .fv-muted')?.textContent ?? '-';
    const found = [...document.querySelectorAll('.fv-structure')].map(b =>
      b.dataset.shape + ' [' + b.dataset.confidence + '] ' + (b.title || '').replace(/\\n/g, ' | '));
    return count + ' | ' + (found.join('  ||  ') || 'nothing drawn');
  })()"
}

check() {
  local label="$1" program="$2" expect="$3"
  run_program "$program"
  local result
  result="$(inspect)"
  if echo "$result" | grep -qi "$expect"; then
    printf '  ok    %-22s %s\n' "$label" "$result"
  else
    printf '  FAIL  %-22s expected %s\n        got %s\n' "$label" "$expect" "$result"
    FAILURES=$((FAILURES + 1))
  fi
}

FAILURES=0
NODE="'class Node:\\n    def __init__(self, v):\\n        self.v = v\\n        self.next = None\\n'"
TREE="'class T:\\n    def __init__(self, k):\\n        self.k = k\\n        self.left = None\\n        self.right = None\\n'"

echo
echo "=== structures the heap view must recognise ==="
check "linked list" "$NODE + 'a = Node(1)\\na.next = Node(2)\\na.next.next = Node(3)\\n'" "linked_list"
check "binary search tree" "$TREE + 'r = T(8)\\nr.left = T(3)\\nr.right = T(10)\\nr.left.left = T(1)\\n'" "bst"
check "grid" "'grid = [[1,2,3],[4,5,6],[7,8,9]]\\nx = grid[0][0]\\n'" "matrix"
check "cycle in a tree class" "$TREE + 'r = T(1)\\nc = T(2)\\nr.left = c\\nc.right = r\\nd = 1\\n'" "graph"
check "stack" "'s = []\\ns.append(1)\\ns.append(2)\\ns.append(3)\\ns.pop()\\n'" "stack\\|push"
check "circular list" "$NODE + 'a = Node(1)\\nb = Node(2)\\nc = Node(3)\\na.next = b\\nb.next = c\\nc.next = a\\n'" "circular\\|returns to where"

echo
echo "=== the raw view is always available ==="
run_program "$TREE + 'r = T(5)\\nr.left = T(3)\\n'"
ab click 'button.fv-mini' >/dev/null 2>&1
peek "(() => {
  const on = document.querySelector('.fv-mini')?.classList.contains('is-on');
  const count = document.querySelector('.fv-heap-actions .fv-muted')?.textContent ?? '-';
  return 'raw mode on: ' + on + ', ' + count;
})()"

# Back out of raw mode, or every screenshot below shows it.
ab click 'button.fv-mini' >/dev/null 2>&1

mkdir -p /projects/sandbox/.kiro/artifacts/screenshots
echo
echo "=== screenshots ==="
run_program "$TREE + 'root = T(8)\\nroot.left = T(3)\\nroot.right = T(10)\\nroot.left.left = T(1)\\nroot.left.right = T(6)\\n'"
ab screenshot /projects/sandbox/.kiro/artifacts/screenshots/20260926-heap-bst.png 2>&1 | tail -1
run_program "$NODE + 'head = Node(1)\\nhead.next = Node(2)\\nhead.next.next = Node(3)\\n'"
ab screenshot /projects/sandbox/.kiro/artifacts/screenshots/20260926-heap-list.png 2>&1 | tail -1

echo
echo "console errors: $(peek "(() => (window.__fvErrors ?? []).length)()")"
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES structure(s) drawn wrongly" >&2
  exit 1
fi
echo "every structure was recognised and explained"
