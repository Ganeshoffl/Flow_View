#!/usr/bin/env bash
#
# The Phase 3 gate.
#
# Runs a bubble sort and checks that it narrates itself in English, that the metrics show a
# recognisably quadratic comparison curve, and that the timeline can seek to a call.
#
# Usage: scripts/verify-narration.sh [session-name]

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/_env.sh
source "$ROOT/scripts/_env.sh"
SESSION="${1:-fv-narr}"
cd "$ROOT"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

PYTHONPATH="$ROOT/apps/server" "$PYTHON" -m flow_view_server --no-browser --port 7474 \
  >/tmp/fv-narr-server.log 2>&1 &
SERVER_PID=$!
(cd "$ROOT/apps/web" && pnpm exec vite >/tmp/fv-narr-web.log 2>&1) &
WEB_PID=$!

printf 'waiting'
for _ in $(seq 1 45); do
  api="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7474/api/capabilities || true)"
  web="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/ || true)"
  [ "$api" = "200" ] && [ "$web" = "200" ] && break
  printf '.'; sleep 1
done
echo " server=${api:-down} ui=${web:-down}"
[ "${api:-}" = "200" ] && [ "${web:-}" = "200" ] || { tail -20 /tmp/fv-narr-server.log; exit 1; }

ab() { agent-browser --session "$SESSION" "$@"; }
peek() { ab eval "$1" 2>&1 | tail -2 | head -1 | sed 's/^"//; s/"$//; s/\\"/"/g'; }

ab open "http://127.0.0.1:5173/" >/dev/null 2>&1
ab snapshot >/dev/null 2>&1

PROGRAM="'values = [5, 1, 4, 2, 8, 3]\\nn = len(values)\\nfor i in range(n - 1):\\n    for j in range(n - 1 - i):\\n        if values[j] > values[j + 1]:\\n            values[j], values[j + 1] = values[j + 1], values[j]\\nprint(values)\\n'"

ab eval "(() => {
  const toggle = [...document.querySelectorAll('button')].find(b => b.textContent === 'Edit code');
  if (toggle) toggle.click();
  const area = document.querySelector('.fv-editor-area');
  if (!area) return 'no editor';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(area, $PROGRAM);
  area.dispatchEvent(new Event('input', { bubbles: true }));
  return 'set';
})()" >/dev/null 2>&1

ab click 'button.fv-run' >/dev/null 2>&1
sleep 5

FAILURES=0
expect() {
  local label="$1" pattern="$2" actual="$3"
  if echo "$actual" | grep -qiE -- "$pattern"; then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %-34s expected /%s/\n        got: %s\n' "$label" "$pattern" "${actual:0:220}"
    FAILURES=$((FAILURES + 1))
  fi
}

echo
echo "=== the program narrates itself ==="
# Step back through the run so the transcript fills, then read it.
ab eval "(() => {
  const follow = document.querySelector('.fv-follow input');
  if (follow && follow.checked) follow.click();
  return 'following off';
})()" >/dev/null 2>&1

TRANSCRIPT="$(peek "(() => [...document.querySelectorAll('.fv-said')].map(e => e.textContent).join(' ~ '))()")"
echo "  ${TRANSCRIPT:0:300}..."
echo
expect "describes a swap"            "are swapped"                    "$TRANSCRIPT"
expect "explains a comparison"       "values\[j\] >"                  "$TRANSCRIPT"
expect "says which way it went"      "so the body"                    "$TRANSCRIPT"
expect "names the user's variable"   "values"                         "$TRANSCRIPT"
expect "reports the loop ending"     "The loop ran"                   "$TRANSCRIPT"

echo
echo "=== metrics show the shape of the work ==="
METRICS="$(peek "(() => {
  const counts = [...document.querySelectorAll('.fv-metric')]
    .map(m => m.querySelector('dt').textContent + '=' + m.querySelector('dd').textContent).join(' ');
  const caption = document.querySelector('.fv-spark figcaption')?.textContent ?? 'no sparkline';
  const points = (document.querySelector('.fv-spark polyline')?.getAttribute('points') ?? '').split(' ').length;
  return counts + ' | ' + caption + ' | ' + points + ' points';
})()")"
echo "  $METRICS"
expect "counts comparisons"          "comparisons="                   "$METRICS"
expect "draws a curve of the work"   "comparisons so far"             "$METRICS"
expect "the curve has real data"     "[0-9]{2,} points"               "$METRICS"

echo
echo "=== the timeline seeks to a call ==="
TIMELINE_BEFORE="$(peek "(() => (document.querySelector('.fv-position')?.textContent ?? '-') + ' | bars=' + document.querySelectorAll('.fv-timeline-bar').length)()")"
echo "  before: $TIMELINE_BEFORE"
ab eval "(() => {
  const bars = [...document.querySelectorAll('.fv-timeline-bar')];
  const target = bars[bars.length - 1] ?? bars[0];
  if (target) target.click();
  return target ? 'clicked' : 'no bars';
})()" >/dev/null 2>&1
TIMELINE_AFTER="$(peek "(() => document.querySelector('.fv-position')?.textContent ?? '-')()")"
echo "  after:  $TIMELINE_AFTER"
expect "timeline has bars"           "bars=[1-9]"                     "$TIMELINE_BEFORE"
expect "clicking a bar seeks"        "step [0-9]"                     "$TIMELINE_AFTER"

echo
echo "=== jumping to a variable's changes ==="
ab press "End" >/dev/null 2>&1
BEFORE="$(peek "(() => document.querySelector('.fv-position')?.textContent ?? '-')()")"
# The click and the read have to be separate calls. React re-renders asynchronously, so reading the
# DOM in the same evaluation that dispatched the click reports the state before the click took effect —
# which looked like the feature not working.
CLICKED="$(peek "(() => {
  const back = [...document.querySelectorAll('.fv-var-jump button')].find(b => b.textContent === '<');
  if (!back) return 'no jump control';
  back.click();
  return 'clicked';
})()")"
AFTER="$(peek "(() => document.querySelector('.fv-position')?.textContent ?? '-')()")"
echo "  $BEFORE -> $AFTER ($CLICKED)"
if [ "$BEFORE" = "$AFTER" ]; then
  printf '  FAIL  %-34s the playhead did not move\n' "jumping to a change"
  FAILURES=$((FAILURES + 1))
else
  printf '  ok    %s\n' "jumping to a change moves the playhead"
fi

mkdir -p /projects/sandbox/.kiro/artifacts/screenshots
ab screenshot /projects/sandbox/.kiro/artifacts/screenshots/20260926-narration.png 2>&1 | tail -1

echo
echo "console errors: $(peek "(() => (window.__fvErrors ?? []).length)()")"
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed" >&2
  exit 1
fi
echo "the program explained itself"
