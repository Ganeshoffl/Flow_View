#!/usr/bin/env bash
#
# Does the browser harness actually fail when it should?
#
# A gate that cannot fail is worse than no gate: it reports success and hides the thing it was built
# to catch. Two of these helpers exist because the previous versions did exactly that — a click that
# landed on <html> printed "Done", and an error count was read from a variable nothing ever set. So
# each helper is checked here against a condition it is supposed to reject.
#
# Usage: scripts/verify-harness.sh [session-name]

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/_env.sh
source "$ROOT/scripts/_env.sh"
AB_SESSION="${1:-fv-harness}"
cd "$ROOT"

cleanup() {
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

(cd "$ROOT/apps/web" && pnpm exec vite >/tmp/fv-harness-web.log 2>&1) &
WEB_PID=$!

printf 'waiting'
for _ in $(seq 1 45); do
  web="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/ || true)"
  [ "$web" = "200" ] && break
  printf '.'; sleep 1
done
echo " ui=${web:-down}"
[ "${web:-}" = "200" ] || { tail -20 /tmp/fv-harness-web.log; exit 1; }

FAILURES=0
expect_ok()   { if [ "$1" = "0" ]; then printf '  ok    %s\n' "$2"; else printf '  FAIL  %s (helper rejected a valid case)\n' "$2"; FAILURES=$((FAILURES+1)); fi; }
expect_fail() { if [ "$1" != "0" ]; then printf '  ok    %s\n' "$2"; else printf '  FAIL  %s (helper accepted a broken case)\n' "$2"; FAILURES=$((FAILURES+1)); fi; }

ab open "http://127.0.0.1:5173/" >/dev/null 2>&1
sleep 2

echo
echo "=== ab_errors refuses to report a number it did not measure ==="
# Deliberately before ab_instrument.
verdict="$(ab_errors)"
if echo "$verdict" | grep -q "NOT INSTRUMENTED"; then
  printf '  ok    uninstrumented page is reported as such\n'
else
  printf '  FAIL  uninstrumented page reported "%s" instead of refusing\n' "$verdict"
  FAILURES=$((FAILURES+1))
fi

ab_instrument >/dev/null

echo
echo "=== ab_errors sees real failures ==="
for kind in "throw new Error('planted sync error')|planted sync error|an uncaught exception" \
            "Promise.reject(new Error('planted rejection'))|planted rejection|an unhandled rejection" \
            "console.error('planted console error')|planted console error|a console.error"; do
  IFS='|' read -r code needle label <<<"$kind"
  ab_eval "(() => { setTimeout(() => { $code }, 0); return 'planted'; })()" >/dev/null
  sleep 1
  # Captured first. Piping a command straight into `grep -q` under `set -o pipefail` reports the
  # producer's SIGPIPE as the pipeline's status whenever grep matches early enough to kill it, so the
  # test would read as failed exactly when it passed.
  recorded="$(ab_errors)"
  if echo "$recorded" | grep -q "$needle"; then
    printf '  ok    %s is recorded\n' "$label"
  else
    printf '  FAIL  %s was not recorded: %s\n' "$label" "$recorded"
    FAILURES=$((FAILURES+1))
  fi
done

# Clear the planted errors so nothing downstream trips over them.
ab_eval "(() => { window.__fv.errors.length = 0; return 'cleared'; })()" >/dev/null
[ "$(ab_errors)" = "0" ] && printf '  ok    the recorder can be cleared\n' \
  || { printf '  FAIL  clearing left %s\n' "$(ab_errors)"; FAILURES=$((FAILURES+1)); }

echo
echo "=== ab_click accepts a real, reachable button ==="
ab_click 'button.fv-run' 2>/dev/null; expect_ok "$?" "the run button is clickable"

echo
echo "=== ab_click rejects what it cannot honestly click ==="
ab_click 'button.does-not-exist' 2>/dev/null; expect_fail "$?" "a selector matching nothing"
ab_click 'button' 2>/dev/null;              expect_fail "$?" "a selector matching many elements"

# Disabled.
ab_eval "(() => { document.querySelector('button.fv-run').disabled = true; return 'ok'; })()" >/dev/null
ab_click 'button.fv-run' 2>/dev/null; expect_fail "$?" "a disabled button"
ab_eval "(() => { document.querySelector('button.fv-run').disabled = false; return 'ok'; })()" >/dev/null

# Zero-sized.
ab_eval "(() => { document.querySelector('button.fv-run').style.display = 'none'; return 'ok'; })()" >/dev/null
ab_click 'button.fv-run' 2>/dev/null; expect_fail "$?" "a hidden button"
ab_eval "(() => { document.querySelector('button.fv-run').style.display = ''; return 'ok'; })()" >/dev/null

# The original bug: on screen, enabled, sized — but covered by something else, so the real mouse event
# lands on the overlay instead. The old helper called this a success.
ab_eval "(() => {
  const o = document.createElement('div');
  o.id = 'planted-overlay';
  Object.assign(o.style, { position: 'fixed', inset: '0', zIndex: '9999', background: 'transparent' });
  document.body.appendChild(o);
  return 'covered';
})()" >/dev/null
ab_click 'button.fv-run' 2>/dev/null; expect_fail "$?" "a button covered by an overlay"
ab_eval "(() => { document.getElementById('planted-overlay').remove(); return 'uncovered'; })()" >/dev/null

echo
echo "=== ab_click_text ==="
ab_click_text button "Examples" 2>/dev/null;      expect_ok   "$?" "an exact button label"
ab_click_text button "No Such Label" 2>/dev/null; expect_fail "$?" "a label matching nothing"

if [ "$FAILURES" -gt 0 ]; then
  echo
  echo "$FAILURES harness check(s) failed - the gates cannot be trusted until these pass" >&2
  exit 1
fi
echo
echo "the harness rejects every broken case it was given"
