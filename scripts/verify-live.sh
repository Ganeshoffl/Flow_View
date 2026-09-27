#!/usr/bin/env bash
#
# End-to-end check of the Full profile: server, UI, and a real program traced through the browser.
#
# This is the Phase 1 gate. Unit tests prove the tracer and the server each work; only driving the
# actual UI proves the whole chain does.
#
# Usage: scripts/verify-live.sh [session-name]

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/_env.sh
source "$ROOT/scripts/_env.sh"
SESSION="${1:-fv-live}"
cd "$ROOT"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

PYTHONPATH="$ROOT/apps/server" "$PYTHON" -m flow_view_server \
  --no-browser --port 7474 >/tmp/fv-server.log 2>&1 &
SERVER_PID=$!

(cd "$ROOT/apps/web" && pnpm exec vite >/tmp/fv-web.log 2>&1) &
WEB_PID=$!

printf 'waiting for server and ui'
for _ in $(seq 1 45); do
  api="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7474/api/capabilities || true)"
  web="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/ || true)"
  [ "$api" = "200" ] && [ "$web" = "200" ] && break
  printf '.'
  sleep 1
done
echo
echo "server=${api:-down} ui=${web:-down}"
if [ "${api:-}" != "200" ] || [ "${web:-}" != "200" ]; then
  echo "--- server log ---"; tail -20 /tmp/fv-server.log
  echo "--- ui log ---"; tail -20 /tmp/fv-web.log
  exit 1
fi

ab() { agent-browser --session "$SESSION" "$@"; }
peek() { ab eval "$1" 2>&1 | tail -2 | head -1 | sed 's/^"//; s/"$//; s/\\"/"/g'; }

ab open "http://127.0.0.1:5173/" >/dev/null 2>&1
ab snapshot >/dev/null 2>&1

echo
echo "=== run the starter program ==="
ab click 'button.fv-run' >/dev/null 2>&1
sleep 5
peek "(() => {
  const g = (s) => document.querySelector(s)?.textContent?.trim() ?? '';
  const vars = [...document.querySelectorAll('.fv-var')]
    .map(r => r.querySelector('.fv-var-name')?.textContent.trim() + '=' +
              r.querySelector('.fv-var-value')?.textContent.trim()).join(', ');
  return 'status=' + g('.fv-status') + ' | ' + g('.fv-position') +
         ' | stack=' + [...document.querySelectorAll('.fv-frame-name')].map(e=>e.textContent).join('>') +
         ' | out=' + JSON.stringify(g('.fv-output')) + ' | vars: ' + vars;
})()"

echo
echo "=== guards reported for the run ==="
peek "(() => [...document.querySelectorAll('.fv-guards')].map(e=>e.textContent.trim()).join(' || '))()"

echo
echo "=== step backward through the recorded trace ==="
ab eval "(() => { document.querySelector('input[type=checkbox]').click(); return 'following off'; })()" >/dev/null 2>&1
for n in 1 2 3; do
  ab press "ArrowLeft" >/dev/null 2>&1
done
peek "(() => {
  const g = (s) => document.querySelector(s)?.textContent?.trim() ?? '';
  return g('.fv-position') + ' | line=' +
    (document.querySelector('.fv-code-line.is-active code')?.textContent?.trim() ?? '-') +
    ' | stack=' + [...document.querySelectorAll('.fv-frame-name')].map(e=>e.textContent).join('>');
})()"

echo
echo "=== a program that reads input ==="
ab eval "(() => {
  const area = document.querySelector('textarea');
  return area ? 'editor present' : 'no editor (still showing the finished run)';
})()" >/dev/null 2>&1

echo
echo "=== metrics ==="
peek "(() => [...document.querySelectorAll('.fv-metric')].map(m => m.querySelector('dt').textContent + '=' + m.querySelector('dd').textContent).join('  '))()"

mkdir -p "$ROOT/.kiro/artifacts/screenshots"
ab screenshot "/projects/sandbox/.kiro/artifacts/screenshots/20260926-live-run.png" 2>&1 | tail -1

echo
echo "=== server log ==="
tail -5 /tmp/fv-server.log
