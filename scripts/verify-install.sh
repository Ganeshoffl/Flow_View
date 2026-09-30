#!/usr/bin/env bash
#
# Does `pip install flow-view[server]` actually give you a working tool?
#
# The user asked for something installable on any system. That is a claim about a wheel, not about a
# checkout, and a checkout hides almost every way it can be wrong: the wheel shipped only the schema
# package for four phases while the UI told people to run a `flow-view` command that did not exist, and
# the server located the tracer by counting three directories above itself, which is the repo root only
# in a repo.
#
# So this installs the built wheel into a clean environment, runs it from a directory with no relation to
# the source, and traces a program end to end over the WebSocket the real UI uses.
#
# Usage: scripts/verify-install.sh

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/_env.sh
source "$ROOT/scripts/_env.sh"
cd "$ROOT"

# Deliberately outside the repository. Anything that still works by finding a source file would pass in
# a temp dir inside it.
VENV=/tmp/flow-view-install-check/venv
NEUTRAL=/tmp/flow-view-install-check/elsewhere
PORT=7699

FAILURES=0
ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

echo "=== build ==="
(cd "$ROOT/apps/web" && pnpm exec vite build >/tmp/fv-install-build.log 2>&1) \
  && ok "the UI builds" || { fail "the UI did not build"; tail -5 /tmp/fv-install-build.log; exit 1; }
rm -rf "$ROOT/dist"
uv build --wheel >/tmp/fv-install-wheel.log 2>&1 \
  && ok "the wheel builds" || { fail "the wheel did not build"; tail -5 /tmp/fv-install-wheel.log; exit 1; }
WHEEL="$(ls "$ROOT"/dist/*.whl | head -1)"

echo
echo "=== install into a clean environment ==="
rm -rf /tmp/flow-view-install-check
mkdir -p "$NEUTRAL"
uv venv "$VENV" >/dev/null 2>&1
if VIRTUAL_ENV="$VENV" uv pip install --quiet "${WHEEL}[server]" >/tmp/fv-install-pip.log 2>&1; then
  ok "pip install 'flow-view[server]' succeeds"
else
  fail "install failed"; tail -10 /tmp/fv-install-pip.log; exit 1
fi

# The command the UI tells people to run has to exist.
if [ -x "$VENV/bin/flow-view" ]; then ok "the flow-view command exists"; else fail "no flow-view command"; fi

echo
echo "=== run it from a directory unrelated to the source ==="
(cd "$NEUTRAL" && "$VENV/bin/flow-view" --no-browser --port "$PORT" >/tmp/fv-install-run.log 2>&1) &
SERVER_PID=$!

for _ in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/capabilities" || true)"
  [ "$code" = "200" ] && break
  sleep 0.5
done
[ "${code:-}" = "200" ] && ok "the API answers" || { fail "the API never came up"; tail -15 /tmp/fv-install-run.log; exit 1; }

# No warning about a missing UI, and the UI is really served from the package.
if grep -q "No built UI found" /tmp/fv-install-run.log; then
  fail "the wheel did not carry the built UI"
else
  ok "the packaged UI was found"
fi
if curl -s "http://127.0.0.1:$PORT/" | grep -q "flow"; then
  ok "the UI is served from the installed package"
else
  fail "the UI is not being served"
fi

PY_OK="$(curl -s "http://127.0.0.1:$PORT/api/capabilities" | "$PYTHON" -c \
  'import json,sys; print(any(l["language"]=="python" and l.get("available") for l in json.load(sys.stdin)["languages"]))' 2>/dev/null)"
[ "$PY_OK" = "True" ] && ok "python is reported as available" || fail "capabilities do not offer python"

# Java too, because the wheel now carries that adapter.
#
# It is one source file with no dependencies, so an installed flow_view can trace Java exactly as a checkout
# can — but only if the file is actually shipped *and* the server looks for it beside the package rather than
# only in a checkout. Both of those are easy to get wrong in a way no test in the repository would notice,
# because in a checkout the fallback path always works.
JAVA_STATE="$(curl -s "http://127.0.0.1:$PORT/api/capabilities" | "$PYTHON" -c \
  'import json,sys
entry = next(l for l in json.load(sys.stdin)["languages"] if l["language"] == "java")
print(entry.get("available"), entry.get("reason") or "")' 2>/dev/null)"
if command -v javac >/dev/null 2>&1; then
  case "$JAVA_STATE" in
    True*) ok "java is reported as available" ;;
    *) fail "a JDK is installed but the wheel does not offer java: $JAVA_STATE" ;;
  esac
else
  # No JDK here, so unavailable is the right answer — but it has to blame the JDK, not the adapter.
  case "$JAVA_STATE" in
    False*JDK*|False*Java*) ok "java is honestly reported as needing a JDK" ;;
    *) fail "java should report a missing JDK, got: $JAVA_STATE" ;;
  esac
fi

echo
echo "=== trace a program the way the UI does ==="
# Over the WebSocket, because that is the path a real run takes - and because bare uvicorn ships no
# WebSocket implementation, so this is what catches a missing `websockets` dependency.
RESULT="$(cd "$NEUTRAL" && "$VENV/bin/python" - <<PYEOF 2>&1
import asyncio, json, urllib.request
try:
    import websockets
except ImportError:
    print("NO-WEBSOCKETS"); raise SystemExit

BASE = "http://127.0.0.1:$PORT"
sid = json.load(urllib.request.urlopen(BASE + "/api/session", data=b""))["id"]

async def go():
    async with websockets.connect(f"ws://127.0.0.1:$PORT/api/session/{sid}/ws") as ws:
        await ws.send(json.dumps({
            "type": "run", "language": "python",
            "source": "total = 0\nfor i in range(10):\n    total += i\nprint(total)\n",
        }))
        out, steps = "", 0
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
            if msg["type"] == "events":
                for e in msg["events"]:
                    if e["t"] == "stdout":
                        out += e["text"]
                    if "step" in e:
                        steps += 1
            elif msg["type"] in ("complete", "error"):
                print(f"{msg['type']}|{out.strip()}|{steps}")
                return

asyncio.run(go())
PYEOF
)"
case "$RESULT" in
  NO-WEBSOCKETS*) fail "the install has no WebSocket support, so no run can ever connect" ;;
  complete\|45\|*)  ok "a program traced end to end and printed 45 ($(echo "$RESULT" | cut -d'|' -f3) steps)" ;;
  *)              fail "the run did not complete: $RESULT" ;;
esac

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed - the wheel is not usable" >&2
  exit 1
fi
echo "an installed flow_view serves its own UI and traces a program"
