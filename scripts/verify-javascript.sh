#!/usr/bin/env bash
#
# The JavaScript adapter, driven through the browser exactly as a user would.
#
# The conformance corpus proves the adapter emits the right trace, and the server tests prove the socket
# forwards it. Neither proves you can pick JavaScript in the UI and watch your program run, which is the
# only claim that matters to someone using this.
#
# Every observation is asserted rather than printed. A gate that reports what it saw without judging it
# reports success whether or not anything happened.
#
# Usage: scripts/verify-javascript.sh [session-name]

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/_env.sh
source "$ROOT/scripts/_env.sh"
AB_SESSION="${1:-fv-js}"
cd "$ROOT"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

# The default ports, deliberately. The dev server's /api proxy target is fixed in vite.config.ts, so a
# gate that moved the API to a port of its own would drive a UI talking to nothing — which is exactly what
# happened, and every assertion after "is JavaScript available" failed for that one reason.
API_PORT=7474
WEB_PORT=5173

PYTHONPATH="$ROOT/apps/server" "$PYTHON" -m flow_view_server \
  --no-browser --port "$API_PORT" >/tmp/fv-js-server.log 2>&1 &
SERVER_PID=$!

(cd "$ROOT/apps/web" && pnpm exec vite >/tmp/fv-js-web.log 2>&1) &
WEB_PID=$!

printf 'waiting for server and ui'
for _ in $(seq 1 45); do
  api="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$API_PORT/api/capabilities" || true)"
  web="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/" || true)"
  [ "$api" = "200" ] && [ "$web" = "200" ] && break
  printf '.'
  sleep 1
done
echo
echo "server=${api:-down} ui=${web:-down}"
if [ "${api:-}" != "200" ] || [ "${web:-}" != "200" ]; then
  echo "--- server log ---"; tail -20 /tmp/fv-js-server.log
  echo "--- ui log ---"; tail -20 /tmp/fv-js-web.log
  exit 1
fi

FAILURES=0
expect() {
  local label="$1" pattern="$2" actual="$3"
  if echo "$actual" | grep -qiE -- "$pattern"; then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %-46s expected /%s/\n        got: %s\n' "$label" "$pattern" "${actual:0:260}"
    FAILURES=$((FAILURES + 1))
  fi
}

await_run() {
  local status=""
  for _ in $(seq 1 60); do
    status="$(ab_eval "(() => document.querySelector('.fv-status')?.textContent)()")"
    case "$status" in
      finished|failed|"waiting for input") break ;;
    esac
    sleep 0.5
  done
  echo "${status:-unknown}"
}

echo
echo "=== the server offers JavaScript ==="
CAPS="$(curl -s "http://127.0.0.1:$API_PORT/api/capabilities")"
expect "javascript is available" '"language":"javascript","available":true' "$CAPS"

ab open "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1
sleep 2
ab_instrument >/dev/null

echo
echo "=== the picker exists and lists JavaScript as runnable ==="
PICKER="$(ab_eval "(() => {
  const select = document.querySelector('.fv-language select');
  if (!select) return 'no selector';
  const options = [...select.options].map((o) => o.value + (o.disabled ? ':disabled' : ':enabled'));
  return 'value=' + select.value + ' options=' + options.join(',');
})()")"
expect "a language picker is present" 'value=' "$PICKER"
expect "javascript is selectable" 'javascript:enabled' "$PICKER"

echo
echo "=== choosing JavaScript swaps the starter program ==="
# Set through the native setter so React's onChange actually fires; assigning .value alone does not.
SWAPPED="$(ab_eval "(() => {
  const select = document.querySelector('.fv-language select');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(select, 'javascript');
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set';
})()")"
expect "the picker accepted the change" 'set' "$SWAPPED"
sleep 1

SOURCE="$(ab_eval "(() => document.querySelector('.cm-editor')?.innerText?.slice(0, 400))()")"
expect "the editor now holds JavaScript" 'function fact' "$SOURCE"
expect "the editor no longer holds Python" '^0$' "$(printf '%s' "$SOURCE" | grep -c 'def fact')"

echo
echo "=== running it produces the program's own output ==="
ab_click ".fv-run" || { echo "  FAIL  could not click Run"; FAILURES=$((FAILURES + 1)); }
STATUS="$(await_run)"
expect "the run finished" 'finished' "$STATUS"

OUTPUT="$(ab_eval "(() => document.querySelector('.fv-area.is-side')?.innerText?.slice(0, 400))()")"
# fact(1..5) = 1, 2, 6, 24, 120. console.log of an array prints it as JSON.
expect "the output is what the program prints" '1,2,6,24,120' "$OUTPUT"

echo
echo "=== the run is labelled JavaScript, not Python ==="
BADGE="$(ab_eval "(() => document.querySelector('.fv-runtime')?.textContent)()")"
expect "the runtime badge names JavaScript" 'JavaScript v?[0-9]+' "$BADGE"

# Scrubbed into the middle of the run before looking at the stack. At the *end* of a finished run the
# stack is correctly just `<module>` — `fact` has long since returned — so asserting on the final frame
# tested nothing about whether calls are being reported at all.
SCRUBBED="$(ab_eval "(() => {
  const scrub = document.querySelector('.fv-scrub input[type=range]');
  if (!scrub) return 'no scrubber';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const middle = Math.floor(Number(scrub.max) * 0.45);
  setter.call(scrub, String(middle));
  scrub.dispatchEvent(new Event('input', { bubbles: true }));
  return 'moved to ' + middle + ' of ' + scrub.max;
})()")"
echo "  $SCRUBBED"
expect "the run can be scrubbed" 'moved to [0-9]+ of [0-9]+' "$SCRUBBED"
sleep 1

STACK="$(ab_eval "(() => document.querySelector('.fv-area.is-stack')?.innerText?.slice(0, 400))()")"
expect "the stack shows the JavaScript function mid-run" 'fact' "$STACK"

echo
echo "=== the panes show this run, not placeholder text ==="
# Measuring the length of a pane's text passes on "Nothing counted yet." — which it did, for four panes, in
# a run where nothing had executed. What matters is that each pane describes *this* program.
VARS="$(ab_eval "(() => document.querySelector('.fv-area.is-vars')?.innerText?.slice(0, 500))()")"
expect "the variables pane names a variable of the program" 'values|\bn\b' "$VARS"

HEAP="$(ab_eval "(() => document.querySelector('.fv-area.is-heap')?.innerText?.slice(0, 500))()")"
expect "the heap pane shows the array that was built" 'Array|list' "$HEAP"

NARR="$(ab_eval "(() => document.querySelector('.fv-area.is-narration')?.innerText?.slice(0, 600))()")"
expect "the narration describes what happened" 'fact|call|return|line' "$NARR"

SIDE="$(ab_eval "(() => document.querySelector('.fv-area.is-side')?.innerText?.slice(0, 700))()")"
expect "the metrics pane counted work" '[1-9][0-9]*' "$SIDE"

echo
echo "=== the code pane highlights JavaScript, not Python ==="
# A Python grammar over JavaScript source still colours *something*, so this checks that the keyword
# `function` — which Python does not have — was tokenised.
TOKENS="$(ab_eval "(() => {
  const pane = document.querySelector('.fv-area.is-code');
  if (!pane) return 'no code pane';
  const spans = [...pane.querySelectorAll('span')];
  const coloured = new Set(spans.map((s) => getComputedStyle(s).color));
  const fn = spans.filter((s) => s.textContent.trim() === 'function').length;
  return 'spans=' + spans.length + ' colours=' + coloured.size + ' functionTokens=' + fn;
})()")"
echo "  $TOKENS"
expect "the code pane is tokenised" 'colours=([2-9]|[1-9][0-9])' "$TOKENS"
expect "'function' is a token of its own" 'functionTokens=[1-9]' "$TOKENS"

echo
echo "=== switching back to Python still works ==="
ab_eval "(() => {
  const select = document.querySelector('.fv-language select');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(select, 'python');
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set';
})()" >/dev/null
sleep 1
ab_click ".fv-run" || { echo "  FAIL  could not click Run for Python"; FAILURES=$((FAILURES + 1)); }
STATUS="$(await_run)"
expect "the Python run finished" 'finished' "$STATUS"
PY_OUTPUT="$(ab_eval "(() => document.querySelector('.fv-area.is-side')?.innerText?.slice(0, 400))()")"
expect "Python printed its own list syntax" '\[1, 2, 6, 24, 120\]' "$PY_OUTPUT"

echo
echo "=== nothing threw in the browser ==="
ERRORS="$(ab_errors)"
echo "  $ERRORS"
expect "no console errors" '^0$' "$ERRORS"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "verify-javascript: all checks passed"
else
  echo "verify-javascript: $FAILURES check(s) failed"
fi
exit "$FAILURES"
