#!/usr/bin/env bash
#
# End-to-end check of the Full profile: server, UI, and a real program traced through the browser.
#
# This is the Phase 1 gate. Unit tests prove the tracer and the server each work; only driving the
# actual UI proves the whole chain does.
#
# Every observation here is asserted. It used to only print what it saw, which meant it reported
# success whether or not anything had been traced — the output looked informative and proved nothing.
#
# Usage: scripts/verify-live.sh [session-name]

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/_env.sh
source "$ROOT/scripts/_env.sh"
AB_SESSION="${1:-fv-live}"
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

FAILURES=0
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
expect() {
  local label="$1" pattern="$2" actual="$3"
  if echo "$actual" | grep -qiE -- "$pattern"; then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %-40s expected /%s/\n        got: %s\n' "$label" "$pattern" "${actual:0:220}"
    FAILURES=$((FAILURES + 1))
  fi
}

# Wait for a run to reach a terminal status, and report which one.
await_run() {
  local status=""
  for _ in $(seq 1 40); do
    status="$(ab_eval "(() => document.querySelector('.fv-status')?.textContent)()")"
    [ "$status" = "finished" ] || [ "$status" = "failed" ] || [ "$status" = "waiting for input" ] && break
    sleep 0.5
  done
  echo "${status:-unknown}"
}

ab open "http://127.0.0.1:5173/" >/dev/null 2>&1
sleep 2
ab_instrument >/dev/null
ab snapshot >/dev/null 2>&1

echo
echo "=== FR-1: the editor highlights what you type ==="
# Counting distinct colours rather than checking for a class name: a stylesheet that defines .tok-keyword
# and a grammar that never emits it would pass a class-name check while showing grey text. This asks the
# browser what colour the pixels actually are.
HIGHLIGHT="$(ab_eval "(() => {
  const spans = [...document.querySelectorAll('.cm-line span')];
  const colours = new Set(spans.map((s) => getComputedStyle(s).color));
  const sample = spans.slice(0, 3).map((s) => JSON.stringify(s.textContent) + '=' + getComputedStyle(s).color);
  return 'editor=' + !!document.querySelector('.cm-editor') +
    ' spans=' + spans.length + ' colours=' + colours.size + ' | ' + sample.join(' ');
})()")"
echo "  $HIGHLIGHT"
expect "the editor is CodeMirror"          "editor=true"      "$HIGHLIGHT"
expect "tokens are actually coloured"      "colours=[3-9]"    "$HIGHLIGHT"

echo
echo "=== run the starter program ==="
ab_click 'button.fv-run' || { echo "the run button was not clicked" >&2; exit 1; }
STATUS="$(await_run)"
RESULT="$(ab_eval "(() => {
  const g = (s) => document.querySelector(s)?.textContent?.trim() ?? '';
  const vars = [...document.querySelectorAll('.fv-var')]
    .map(r => r.querySelector('.fv-var-name')?.textContent.trim() + '=' +
              r.querySelector('.fv-var-value')?.textContent.trim()).join(', ');
  return 'status=' + g('.fv-status') + ' | ' + g('.fv-position') +
         ' | stack=' + [...document.querySelectorAll('.fv-frame-name')].map(e=>e.textContent).join('>') +
         ' | out=' + JSON.stringify(g('.fv-output')) + ' | vars: ' + vars;
})()")"
echo "  $RESULT"
expect "the run finished"                 "status=finished"           "$RESULT"
# The starter program computes factorials 1..5 and prints the list.
expect "the program's output is captured" "\[1, 2, 6, 24, 120\]"      "$RESULT"
expect "the trace has real length"        "step [0-9]{2,} / [0-9]{2,}" "$RESULT"
# The name cell holds the jump-to-change controls as well as the name, so there is markup between the
# two. What matters is that the user's own variable is listed holding the list it built.
expect "the user's variables are shown"   "values.*=list\[5\]"        "$RESULT"
expect "a loop counter is shown"          "i.*=5"                     "$RESULT"

echo
echo "=== and the code pane highlights what ran ==="
# The pane the user actually watches. It is not an editor and must not become one - the active line,
# the visit counts and the click-to-seek all live in its own markup - so it tokenises with the same
# grammars and renders spans inside the markup it already had.
PANE="$(ab_eval "(() => {
  const spans = [...document.querySelectorAll('.fv-code-text span')];
  const colours = new Set(spans.map((s) => getComputedStyle(s).color));
  return 'lines=' + document.querySelectorAll('.fv-code-line').length +
    ' spans=' + spans.length + ' colours=' + colours.size +
    ' | text intact: ' + JSON.stringify(
      document.querySelector('.fv-code-line .fv-code-text')?.textContent);
})()")"
echo "  $PANE"
expect "the code pane colours tokens too"  "colours=[3-9]"    "$PANE"
# Adding spans must not disturb the text, or every line-based assertion in these gates is reading
# something different from what the program says.
expect "the source text is unchanged"      "def fact\(n\):"   "$PANE"

echo
echo "=== guards reported for the run ==="
GUARDS="$(ab_eval "(() => [...document.querySelectorAll('.fv-guards')].map(e=>e.textContent.trim()).join(' || '))()")"
echo "  $GUARDS"
expect "the run names its sandbox guards" "Protecting this run"       "$GUARDS"

echo
echo "=== step backward through the recorded trace ==="
if ab_eval "(() => document.querySelector('.fv-follow input')?.checked)()" | grep -q true; then
  ab_click '.fv-follow input' || fail "could not stop following the live edge"
fi
BEFORE="$(ab_eval "(() => document.querySelector('.fv-position')?.textContent?.trim())()")"
for _ in 1 2 3; do ab press "ArrowLeft" >/dev/null 2>&1; done
STEPPED="$(ab_eval "(() => {
  const g = (s) => document.querySelector(s)?.textContent?.trim() ?? '';
  return g('.fv-position') + ' | line=' +
    (document.querySelector('.fv-code-line.is-active code')?.textContent?.trim() ?? '-') +
    ' | stack=' + [...document.querySelectorAll('.fv-frame-name')].map(e=>e.textContent).join('>');
})()")"
echo "  $BEFORE -> $STEPPED"
AFTER="${STEPPED%% |*}"
if [ "$BEFORE" = "$AFTER" ]; then
  fail "stepping back did not move the playhead (still $AFTER)"
else
  printf '  ok    %s\n' "stepping back moves the playhead"
fi
expect "a line is highlighted while paused" "line=[^-]"               "$STEPPED"

echo
echo "=== a program that reads input ==="
# Prefilled input is recorded as part of the trace, so the whole run can be scrubbed afterwards
# without anyone typing.
ab_click_text button "Edit code" || fail "could not switch back to the editor"
ab_set_source 'name = input("your name? ")
print("hello", name)
' || fail "the editor did not take the program"
ab_click_text button "Input" || fail "could not open the input panel"
ab fill '.fv-stdin-prefill textarea' 'Ada' >/dev/null 2>&1
ab_click 'button.fv-run' || fail "the second run was not started"
STATUS="$(await_run)"
INPUT_RUN="$(ab_eval "(() => {
  const g = (s) => document.querySelector(s)?.textContent?.trim() ?? '';
  return 'status=' + g('.fv-status') + ' | out=' + JSON.stringify(g('.fv-output')) +
    ' | vars: ' + [...document.querySelectorAll('.fv-var')].map(r =>
      r.querySelector('.fv-var-name')?.textContent.trim() + '=' +
      r.querySelector('.fv-var-value')?.textContent.trim()).join(', ');
})()")"
echo "  $INPUT_RUN"
expect "the run using input finished"   "status=finished"             "$INPUT_RUN"
expect "the prefilled value was read"   "Ada"                         "$INPUT_RUN"
expect "the program greeted the input"  "hello Ada"                   "$INPUT_RUN"

echo
echo "=== a program that waits for a person to answer ==="
# Prefilled input replays without anyone typing. This is the other half: the program stops, the UI
# asks, and the answer is typed in. It only works because the tracer flushes before a blocking read —
# until it did, the question sat in an 8 KB stdout buffer that could not be emptied until the program
# ended, and the program could not end until the question was answered.
ab_click_text button "Edit code" || fail "could not switch back to the editor"
ab_set_source 'age = input("how old? ")
print("in ten years:", int(age) + 10)
' || fail "the editor did not take the program"
# Clear the prefill, or there is nothing to wait for. Select-all and delete, the way a person would:
# filling with an empty string leaves the field looking empty without telling React, and the stale
# value is still what gets run — which made this check report that the program never asked a question.
ab focus '.fv-stdin-prefill textarea' >/dev/null 2>&1
ab press 'Control+a' >/dev/null 2>&1
ab press 'Delete' >/dev/null 2>&1
CLEARED="$(ab_eval "(() => 'box=' + JSON.stringify(document.querySelector('.fv-stdin-prefill textarea')?.value) +
  ' prefillStillSet=' + !!document.querySelector('.fv-dot'))()")"
expect "the prefilled input was cleared" 'box="" prefillStillSet=false' "$CLEARED"
ab_click 'button.fv-run' || fail "the interactive run was not started"

ASKED=""
for _ in $(seq 1 30); do
  ASKED="$(ab_eval "(() => {
    const p = document.querySelector('.fv-ask-prompt')?.textContent?.trim();
    return (p ? 'prompt=' + JSON.stringify(p) : 'no prompt') +
      ' status=' + document.querySelector('.fv-status')?.textContent;
  })()")"
  echo "$ASKED" | grep -q 'prompt=' && break
  sleep 0.5
done
echo "  $ASKED"
expect "the program's question is shown"  'prompt="how old\?'          "$ASKED"
expect "the UI says it is waiting"        "waiting for input"          "$ASKED"

if echo "$ASKED" | grep -q 'prompt='; then
  ab fill '.fv-ask input' '32' >/dev/null 2>&1
  ab_click_text button "Send" || fail "could not send the answer"
  STATUS="$(await_run)"
  ANSWERED="$(ab_eval "(() => {
    const g = (s) => document.querySelector(s)?.textContent?.trim() ?? '';
    return 'status=' + g('.fv-status') + ' | out=' + JSON.stringify(g('.fv-output'));
  })()")"
  echo "  $ANSWERED"
  expect "the run finished once answered"  "status=finished"           "$ANSWERED"
  expect "the typed answer was used"       "in ten years: 42"          "$ANSWERED"
  GONE="$(ab_eval "(() => 'askBoxStillThere=' + !!document.querySelector('.fv-ask input'))()")"
  expect "the question box is dismissed"   "askBoxStillThere=false"    "$GONE"
else
  fail "the program never asked, so the answer could not be typed"
fi

echo
echo "=== metrics ==="
METRICS="$(ab_eval "(() => [...document.querySelectorAll('.fv-metric')].map(m => m.querySelector('dt').textContent + '=' + m.querySelector('dd').textContent).join('  '))()")"
echo "  $METRICS"
expect "metrics are counted"            "assignments=[1-9]"           "$METRICS"

mkdir -p "$ROOT/.kiro/artifacts/screenshots"
ab screenshot "/projects/sandbox/.kiro/artifacts/screenshots/20260926-live-run.png" 2>&1 | tail -1

echo
errors="$(ab_errors)"
echo "console errors: $errors"
[ "$errors" = "0" ] || fail "the page reported errors: $errors"

echo
echo "=== server log ==="
tail -5 /tmp/fv-server.log

if [ "$FAILURES" -gt 0 ]; then
  echo
  echo "$FAILURES check(s) failed" >&2
  exit 1
fi
echo
echo "the whole chain traced a program, replayed it, and read input"
