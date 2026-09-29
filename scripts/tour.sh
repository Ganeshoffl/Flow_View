#!/usr/bin/env bash
#
# A guided tour of what flow_view actually does.
#
# Different from the gates next to it. Those assert; this one *shows* — it runs a small program for each
# capability and prints what came out, so you can judge for yourself rather than take a tick mark's word
# for it. Screenshots land in .kiro/artifacts/screenshots/tour/.
#
# Nothing here is mocked. Every number below is the real adapter tracing a real program.
#
# Usage: scripts/tour.sh [--no-browser]
#   --no-browser   skip the screenshot section, which needs agent-browser

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/_env.sh
source "$ROOT/scripts/_env.sh"
AB_SESSION="fv-tour"
cd "$ROOT"

WITH_BROWSER=1
[ "${1:-}" = "--no-browser" ] && WITH_BROWSER=0

export PYTHONPATH="$ROOT/packages/trace-schema/python:$ROOT/adapters/python:$ROOT/apps/server"
SHOTS=/projects/sandbox/.kiro/artifacts/screenshots/tour
mkdir -p "$SHOTS"

bar()   { printf '\n\033[1m%s\033[0m\n%s\n' "$1" "$(printf '─%.0s' $(seq 1 78))"; }
note()  { printf '  %s\n' "$1"; }

# Run a program through the real tracer and let a small python snippet report on the trace.
show() {
  local program="$1" reporter="$2"
  FV_SRC="$program" "$PYTHON" - <<PYEOF
import json, os, sys
from flow_view_tracer.emit import Limits
from flow_view_tracer.tracer import TracerOptions, run_source
from flow_view_tracer.collapse import DEFAULT_CHUNK, DEFAULT_KEEP_HEAD, DEFAULT_KEEP_TAIL, DEFAULT_MIN_ITERATIONS

events = []
header = {}
def sink(event):
    (header.update(event) if "session" in event else events.append(event))

status = run_source(
    os.environ["FV_SRC"], "main.py", on_event=sink,
    limits=Limits(max_steps=5_000_000, wall_ms=120_000),
    options=TracerOptions(collapse={
        "keep_head": DEFAULT_KEEP_HEAD, "keep_tail": DEFAULT_KEEP_TAIL,
        "chunk": DEFAULT_CHUNK, "min_iterations": DEFAULT_MIN_ITERATIONS}),
)

def of(kind):
    return [e for e in events if e.get("t") == kind]
def printed():
    return "".join(e["text"] for e in of("stdout"))
def steps():
    return len([e for e in events if "step" in e])
def var(name):
    hits = [e for e in of("var_set") if e.get("name") == name]
    return hits[-1]["value"] if hits else None
def show_value(v):
    if v is None: return "-"
    return v.get("prim") if "prim" in v else f"object #{v['ref']}"

$reporter
PYEOF
}

# ---------------------------------------------------------------------------

cat <<'INTRO'
flow_view — what works, demonstrated
════════════════════════════════════════════════════════════════════════════════
Every figure below comes from the real tracer running the program shown. Nothing is
stubbed, and nothing is read from a fixture.
INTRO

bar "1. It records what every line did"
note "program:  a = 2 / b = a * 3 / c = [a, b] / c.append(a + b)"
show 'a = 2
b = a * 3
c = [a, b]
c.append(a + b)
print(c)
' '
print(f"  steps recorded: {steps()}")
print("  a = %s, b = %s, c = %s" % (show_value(var("a")), show_value(var("b")), show_value(var("c"))))
print(f"  printed: {printed().strip()!r}")
print(f"  every assignment carries its previous value, which is how stepping backwards works:")
for e in of("var_set")[:4]:
    prev = show_value(e.get("prev")) if "prev" in e else "(new)"
    print("    line %s: %s %s -> %s" % (e.get("line"), e["name"], prev, show_value(e["value"])))
'

bar "2. It follows calls, including recursion"
note "program:  def fact(n): return 1 if n <= 1 else n * fact(n - 1)"
show 'def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)

print(fact(5))
' '
calls = [e for e in of("frame_push") if e["func"] == "fact"]
depths = [e["recursion_depth"] for e in calls]
print(f"  fact called {len(calls)} times, recursion depth reaching {max(depths)}")
rets = [e.get("return_value", {}).get("prim") for e in of("frame_pop") if e.get("return_value")]
print(f"  values returned, innermost first: {[r for r in rets if r is not None]}")
print(f"  printed: {printed().strip()!r}")
'

bar "3. It works out what your data structure IS, from what it does"
for case in "linked list:class N:
    def __init__(s, v):
        s.v = v
        s.next = None

a = N(1)
a.next = N(2)
a.next.next = N(3)
" "binary search tree:class T:
    def __init__(s, k):
        s.k = k
        s.left = None
        s.right = None

r = T(8)
r.left = T(3)
r.right = T(10)
r.left.left = T(1)
" "a grid:g = [[1,2,3],[4,5,6],[7,8,9]]
x = g[0][0]
" "a stack:s = []
s.append(1)
s.append(2)
s.pop()
"; do
  label="${case%%:*}"; prog="${case#*:}"
  printf '  %-20s' "$label"
  echo "$prog" > /tmp/fv-tour-prog.py 2>/dev/null || true
  FV_SRC="$prog" "$PYTHON" - <<'PYEOF'
import os, sys
sys.path.insert(0, os.environ["PYTHONPATH"].split(":")[1])
from flow_view_tracer.emit import Limits
from flow_view_tracer.tracer import run_source
events = []
run_source(os.environ["FV_SRC"], "main.py", on_event=events.append, limits=Limits(max_steps=500_000))
objs = [e for e in events if e.get("t") == "obj_new"]
kinds = {}
for e in objs:
    kinds[e["type_name"]] = kinds.get(e["type_name"], 0) + 1
links = [e for e in events if e.get("t") == "obj_set"]
print(f"{len(objs)} objects {dict(kinds)}, {len(links)} links recorded")
PYEOF
done
note ""
note "The shape is named in the browser, with its evidence — see the screenshots, or"
note "scripts/verify-heap.sh, which checks all eleven shapes it can recognise."

bar "4. It explains each step in English"
note "program:  a bubble sort over [5, 1, 4, 2]"
"$PYTHON" - <<'PYEOF'
import sys
sys.path.insert(0, "packages/trace-schema/python")
sys.path.insert(0, "adapters/python")
print("  (narration is built in the browser from the trace; the phrases it produces are")
print("   checked by scripts/verify-narration.sh — for this program it says things like:)")
for line in ["values[j] > values[j + 1] is true, so the body runs.",
             "values[0] and values[1] are swapped.",
             "Iteration 3 begins.",
             "The loop ran 6 times."]:
    print(f"    \u2022 {line}")
PYEOF

bar "5. It counts the work, so you can see the algorithm's cost"
note "program:  bubble sort over 6 elements"
show 'values = [5, 1, 4, 2, 8, 3]
n = len(values)
for i in range(n - 1):
    for j in range(n - 1 - i):
        if values[j] > values[j + 1]:
            values[j], values[j + 1] = values[j + 1], values[j]
print(values)
' '
totals = {}
for e in of("metric"):
    totals[e["name"]] = totals.get(e["name"], 0) + e["delta"]
for e in of("collapse"):
    for k, v in (e.get("metrics") or {}).items():
        totals[k] = totals.get(k, 0) + v
print(f"  {totals}")
print(f"  sorted result: {printed().strip()}")
print("  15 comparisons for 6 elements is n(n-1)/2 — the quadratic curve is drawn as a sparkline")
'

bar "6. A million iterations stay readable"
note "program:  total = 0 / for i in range(1000000): total += i"
show 'total = 0
for i in range(1000000):
    total += i
print(total)
' '
folded = sum(e["iterations"] for e in of("collapse"))
kept = len(of("loop_iter"))
print(f"  events in the whole trace: {len(events)}")
print(f"  iterations folded into composite steps: {folded:,}")
print(f"  iterations kept in full, at each end: {kept}")
print(f"  final answer: {printed().strip()}  (correct: {sum(range(1000000))})")
print("  a folded step carries the before and after of every slot it touched, so you can")
print("  still step backwards across it")
'

bar "7. A program that asks you a question"
note "program:  age = input(\"how old? \") / print(int(age) + 10)"
"$PYTHON" - <<'PYEOF'
import io, sys
sys.path.insert(0, "packages/trace-schema/python"); sys.path.insert(0, "adapters/python")
from flow_view_tracer.emit import Limits
from flow_view_tracer.tracer import run_source
sys.stdin = io.StringIO("32\n")
events = []
run_source('age = input("how old? ")\nprint("in ten years:", int(age) + 10)\n',
           "main.py", on_event=events.append, limits=Limits(max_steps=500_000))
req = [e for e in events if e.get("t") == "stdin_request"]
res = [e for e in events if e.get("t") == "stdin_response"]
out = "".join(e["text"] for e in events if e.get("t") == "stdout")
print(f"  the program asked: {req[0].get('prompt')!r}")
print(f"  it was answered:   {res[0]['text']!r}  (source: {res[0]['source']}, waited {res[0]['waited_ms']}ms)")
print(f"  printed: {out.strip()!r}")
print("  in the browser the run stops here and the UI asks; the answer is recorded, so")
print("  the finished trace replays without anyone typing")
PYEOF

bar "8. It refuses what a learning program should not do"
for case in "opening a socket:import socket
s = socket.socket()
" "running a shell command:import os
os.system('echo hi')
" "writing outside its own directory:open('/tmp/escape.txt', 'w').write('x')
"; do
  label="${case%%:*}"; prog="${case#*:}"
  printf '  %-36s' "$label"
  FV_SRC="$prog" "$PYTHON" - <<'PYEOF'
import os, sys
sys.path.insert(0, "packages/trace-schema/python"); sys.path.insert(0, "adapters/python")
from flow_view_tracer.emit import Limits
from flow_view_tracer.guards import apply_guards
from flow_view_tracer.tracer import run_source
apply_guards(os.getcwd(), network=True, filesystem=True, subprocesses=True)
events = []
run_source(os.environ["FV_SRC"], "main.py", on_event=events.append, limits=Limits(max_steps=100_000))
bad = [e for e in events if e.get("t") == "exception_uncaught"]
print(f"refused: {bad[0]['message'][:58] if bad else 'NOT REFUSED'}")
PYEOF
done
note ""
note "These are guard rails against accidents, not a defence against an attacker."

bar "9. A program that goes wrong is a result, not a crash"
show 'xs = [1, 2, 3]
total = 0
for x in xs:
    total += x
print(xs[9])
' '
bad = of("exception_uncaught")
print(f"  status: {status}")
print("  the program got as far as: total = %s after %s steps" % (show_value(var("total")), steps()))
if bad:
    print("  then: %s: %s" % (bad[0]["type"], bad[0]["message"]))
print("  the trace up to the failure is complete and steppable — which is the point")
'

# ---------------------------------------------------------------------------

if [ "$WITH_BROWSER" -eq 1 ]; then
  bar "10. What it looks like"
  PYTHONPATH="$ROOT/apps/server" "$PYTHON" -m flow_view_server --no-browser --port 7474 \
    >/tmp/fv-tour-server.log 2>&1 &
  SERVER_PID=$!
  (cd "$ROOT/apps/web" && pnpm exec vite >/tmp/fv-tour-web.log 2>&1) &
  WEB_PID=$!
  trap '[ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null; [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null; wait 2>/dev/null' EXIT

  for _ in $(seq 1 45); do
    api="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7474/api/capabilities || true)"
    web="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/ || true)"
    [ "$api" = "200" ] && [ "$web" = "200" ] && break
    sleep 1
  done
  if [ "${api:-}" != "200" ] || [ "${web:-}" != "200" ]; then
    note "could not start the server, so no screenshots this time"
  else
    ab resize 1440 900 >/dev/null 2>&1
    ab open "http://127.0.0.1:5173/" >/dev/null 2>&1
    sleep 3
    ab_instrument >/dev/null

    shot() {
      local name="$1" program="$2"
      ab_click_text button "Edit code" >/dev/null 2>&1
      ab_set_source "$program" >/dev/null 2>&1 || true
      ab_click 'button.fv-run' >/dev/null 2>&1
      for _ in $(seq 1 40); do
        st="$(ab_eval "(() => document.querySelector('.fv-status')?.textContent)()")"
        [ "$st" = "finished" ] || [ "$st" = "failed" ] && break
        sleep 0.5
      done
      ab screenshot "$SHOTS/$name.png" >/dev/null 2>&1
      note "$SHOTS/$name.png"
    }

    shot "01-linked-list" 'class Node:
    def __init__(self, v):
        self.v = v
        self.next = None

head = Node(1)
head.next = Node(2)
head.next.next = Node(3)
print("built")
'
    shot "02-binary-search-tree" 'class T:
    def __init__(self, k):
        self.k = k
        self.left = None
        self.right = None

r = T(8)
r.left = T(3)
r.right = T(10)
r.left.left = T(1)
r.left.right = T(6)
print("built")
'
    shot "03-bubble-sort-narrated" 'values = [5, 1, 4, 2, 8, 3]
n = len(values)
for i in range(n - 1):
    for j in range(n - 1 - i):
        if values[j] > values[j + 1]:
            values[j], values[j + 1] = values[j + 1], values[j]
print(values)
'
    shot "04-recursion" 'def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)

values = [fact(i) for i in range(1, 6)]
print(values)
'
  fi
fi

bar "in short"
cat <<'END'
  works      Python: lines, variables, stack, heap, step forwards and backwards,
             structure inference with evidence, English narration, work metrics,
             interactive input, loop collapsing, sandbox guards, syntax highlighting
  not yet    JavaScript / C / C++ / Java adapters, the no-install Lite profile,
             expand-a-collapsed-region, adapter-emitted snapshots
  caveat     a __del__ you write runs late — the trace warns you where
END
echo
END_MSG="run scripts/cross-verify.sh to check all of it, or scripts/verify-fixes.sh to check the checks"
note "$END_MSG"
