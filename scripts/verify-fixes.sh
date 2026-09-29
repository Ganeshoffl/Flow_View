#!/usr/bin/env bash
#
# Does the suite actually catch the bugs it was written for?
#
# Every fix in this repository was made because something was wrong. A fix with no test that fails
# without it is not a fix, it is a hope — and this session found two of those: a finalizer test that
# collected its garbage before tracing began and so passed with the fix reverted, and a library-frame
# fix that 298 tests were perfectly happy to have removed.
#
# So each fix is reverted in turn and the suite is required to notice. A mutation that survives is
# reported, because that is exactly the gap it names.
#
# Usage: scripts/verify-fixes.sh [--quick]
#   --quick  skip the repeat runs that check the two former flakes

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/_env.sh
source "$ROOT/scripts/_env.sh"
cd "$ROOT"

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

export PYTHONPATH="$ROOT/packages/trace-schema/python:$ROOT/adapters/python:$ROOT/apps/server"
PY_SUITE="packages/trace-schema/python/tests adapters/python/tests apps/server/tests conformance/tests"

SURVIVORS=0
CHECKED=0

#: Seconds any single suite run may take before it is killed.
#:
#: This script's whole job is to put bugs back, and several of those bugs are deadlocks - a tracer that
#: never flushes, a server that only batches on arrival. Reintroducing one hung pytest for twenty-five
#: minutes before I gave up on it. A gate that can hang is a gate nobody will run, so every wait here is
#: bounded and a run that has to be killed says so rather than looking like a pass.
RUN_TIMEOUT=180

# Backups live inside the repo so an interrupted run shows up in `git status` rather than leaving a
# mutation behind unnoticed. /tmp does not survive between steps in this environment.
BACKUP_DIR="$ROOT/.mutation-backups"
mkdir -p "$BACKUP_DIR"

key_for() { echo "$1" | tr '/' '%'; }

restore_all() {
  local saved name
  for saved in "$BACKUP_DIR"/*.bak; do
    [ -e "$saved" ] || continue
    name="$(basename "$saved" .bak | tr '%' '/')"
    cp "$saved" "$ROOT/$name"
    rm -f "$saved"
  done
  rmdir "$BACKUP_DIR" 2>/dev/null || true
}
trap restore_all EXIT

# mutate <file> <old text> <new text>
#
# Old and new travel through the environment rather than spliced into a command line: bash strips null
# bytes from command substitution, so an in-band separator silently produced half a mutation and every
# check reported itself broken.
mutate() {
  local file="$1" old="$2" new="$3"
  cp "$ROOT/$file" "$BACKUP_DIR/$(key_for "$file").bak"
  FV_FILE="$ROOT/$file" FV_OLD="$old" FV_NEW="$new" "$PYTHON" "$ROOT/scripts/_mutate.py"
}

unmutate() {
  local file="$1" saved
  saved="$BACKUP_DIR/$(key_for "$file").bak"
  cp "$saved" "$ROOT/$file"
  rm -f "$saved"
}

# check <label> <file> <old> <new> <pytest selection...>
check() {
  local label="$1" file="$2" old="$3" new="$4"; shift 4
  CHECKED=$((CHECKED + 1))
  if ! mutate "$file" "$old" "$new"; then
    printf '  \033[31mBROKEN\033[0m   %-52s the mutation no longer applies\n' "$label"
    SURVIVORS=$((SURVIVORS + 1))
    rm -f "$BACKUP_DIR/$(key_for "$file").bak"
    return
  fi
  local out
  out="$(timeout "$RUN_TIMEOUT" "$PYTHON" -m pytest "$@" --tb=no -rN 2>&1)"
  local status=$?
  if [ "$status" -eq 124 ]; then
    # The mutation was noticed, but by hanging. Worth distinguishing: a suite that has to be killed is a
    # far worse failure mode than one that reports.
    printf '  \033[33mcaught\033[0m   %-52s by hanging - killed after %ss\n' "$label" "$RUN_TIMEOUT"
  elif echo "$out" | grep -q "failed"; then
    printf '  \033[32mcaught\033[0m   %-52s %s\n' "$label" \
      "$(echo "$out" | grep -oE '[0-9]+ failed' | head -1)"
  else
    printf '  \033[31mSURVIVED\033[0m %-52s %s\n' "$label" \
      "$(echo "$out" | grep -oE '[0-9]+ passed' | head -1)"
    SURVIVORS=$((SURVIVORS + 1))
  fi
  unmutate "$file"
}

# check_vitest <label> <file> <old> <new> <vitest path>
#
# The JavaScript adapter's unit tests run under vitest, not pytest. Same contract as `check`: put the bug
# back, require the suite to notice, report it as a survivor if it does not.
check_vitest() {
  local label="$1" file="$2" old="$3" new="$4" suite="$5"
  CHECKED=$((CHECKED + 1))
  if ! mutate "$file" "$old" "$new"; then
    printf '  \033[31mBROKEN\033[0m   %-52s the mutation no longer applies\n' "$label"
    SURVIVORS=$((SURVIVORS + 1))
    rm -f "$BACKUP_DIR/$(key_for "$file").bak"
    return
  fi
  local out status
  out="$(timeout "$RUN_TIMEOUT" pnpm exec vitest run "$suite" 2>&1)"
  status=$?
  if [ "$status" -eq 124 ]; then
    printf '  \033[33mcaught\033[0m   %-52s by hanging - killed after %ss\n' "$label" "$RUN_TIMEOUT"
  elif echo "$out" | grep -qE "[0-9]+ failed"; then
    printf '  \033[32mcaught\033[0m   %-52s %s\n' "$label" \
      "$(echo "$out" | grep -oE '[0-9]+ failed' | head -1)"
  else
    printf '  \033[31mSURVIVED\033[0m %-52s %s\n' "$label" \
      "$(echo "$out" | grep -oE '[0-9]+ passed' | head -1)"
    SURVIVORS=$((SURVIVORS + 1))
  fi
  unmutate "$file"
}

# check_corpus <label> <file> <old> <new>
#
# The conformance corpus is a script rather than a pytest suite, so it needs its own runner. This is the
# level that catches a wrong *trace* — a mutation can leave every unit test happy and still make the
# adapter describe the program incorrectly, and only running the corpus finds that.
check_corpus() {
  local label="$1" file="$2" old="$3" new="$4"
  CHECKED=$((CHECKED + 1))
  if ! mutate "$file" "$old" "$new"; then
    printf '  \033[31mBROKEN\033[0m   %-52s the mutation no longer applies\n' "$label"
    SURVIVORS=$((SURVIVORS + 1))
    rm -f "$BACKUP_DIR/$(key_for "$file").bak"
    return
  fi
  local out status
  out="$(timeout "$RUN_TIMEOUT" "$PYTHON" conformance/runner.py 2>&1)"
  status=$?
  if [ "$status" -eq 124 ]; then
    printf '  \033[33mcaught\033[0m   %-52s by hanging - killed after %ss\n' "$label" "$RUN_TIMEOUT"
  elif [ "$status" -ne 0 ]; then
    printf '  \033[32mcaught\033[0m   %-52s %s\n' "$label" \
      "$(echo "$out" | grep -oE '[0-9]+/[0-9]+ passed' | head -1)"
  else
    printf '  \033[31mSURVIVED\033[0m %-52s %s\n' "$label" \
      "$(echo "$out" | grep -oE '[0-9]+/[0-9]+ passed' | head -1)"
    SURVIVORS=$((SURVIVORS + 1))
  fi
  unmutate "$file"
  # The corpus writes traces as it goes, so a mutated run leaves mutated traces behind for the replay
  # suite to read. Regenerated here rather than left for whatever runs next.
  timeout "$RUN_TIMEOUT" "$PYTHON" conformance/runner.py >/dev/null 2>&1
}

heading() { printf '\n\033[1m%s\033[0m\n' "$1"; }

TRACER=adapters/python/flow_view_tracer/tracer.py
EMIT=adapters/python/flow_view_tracer/emit.py
RUNNER=apps/server/flow_view_server/runner.py
APP=apps/server/flow_view_server/app.py
ANALYSIS=adapters/python/flow_view_tracer/analysis.py
WALK=adapters/python/flow_view_tracer/walk.py

heading "the program's own execution, and nothing else"

check "a library call's interior harvested on return" "$TRACER" \
  'if not self._unwinding and state.kind != "library":' \
  'if not self._unwinding:' \
  adapters/python/tests apps/server/tests

check "foreign finalizers counted as the program's work" "$TRACER" \
  '            or self._is_foreign_finalizer(frame)
' \
  '' \
  conformance/tests

check "refusing a finalizer does not cascade to its callees" "$TRACER" \
  'while current is not None and hops < _FINALIZER_SEARCH_LIMIT:' \
  'while current is not None and hops < 0:' \
  conformance/tests

check "the user's own __del__ refused along with the rest" "$TRACER" \
  'if code.co_name == "__del__" and not self._is_user_file(code.co_filename):' \
  'if code.co_name == "__del__":' \
  conformance/tests

check "every nested internal frame announced again" "$TRACER" \
  'if self._frame_stack and self._frame_stack[-1].kind == "library":' \
  'if False:' \
  adapters/python/tests

# The callback this protects is reached through a library's own Python frame, which only
# sys.monitoring is sensitive to - so the test lives with the backend comparison, not with the tracer.
check "in_scope stops at the immediate caller" "$TRACER" \
  'hops = 0
        current = frame.f_back
        while current is not None and hops < _FINALIZER_SEARCH_LIMIT:' \
  'hops = 0
        current = frame.f_back
        while current is not None and hops < 1:' \
  adapters/python/tests conformance/tests

heading "the heap holds the program's data, and nothing else"

check "interpreter bindings used as heap roots" "$TRACER" \
  'if not is_atomic(value) and not is_interpreter_name(name)' \
  'if not is_atomic(value)' \
  adapters/python/tests

check "flow_view's own objects walked" "$WALK" \
  '    if _is_flow_view_object(obj):
        return False
' \
  '' \
  adapters/python/tests

check "a library's private exceptions reported as the program's" "$TRACER" \
  '        state = self._frames.get(id(frame))
        if state is None or state.kind == "library":' \
  '        state = self._frames.get(id(frame))
        if False:' \
  adapters/python/tests

heading "a blocked program can still speak"

check "the tracer never flushes" "$EMIT" \
  'if kind in self.URGENT:' 'if False:' \
  adapters/python/tests apps/server/tests

check "the server batches only when an event arrives" "$APP" \
  'timeout = BATCH_INTERVAL if batch else None' 'timeout = None' \
  apps/server/tests

check "prefilled stdin written without its newline" "$RUNNER" \
  'if not text.endswith("\n"):
                text += "\n"
            self._prefilled_lines' \
  'self._prefilled_lines' \
  apps/server/tests

check "the read deadline fires while awaiting input" "$RUNNER" \
  'timeout=UNANSWERED_DEADLINE if awaiting_input else wall_deadline' \
  'timeout=wall_deadline' \
  apps/server/tests

check "where an answer came from, hardcoded again" "$RUNNER" \
  'event["source"] = "interactive"' 'event["source"] = "prefilled"' \
  apps/server/tests

check "a person's thinking time charged to the program" "$EMIT" \
  'return (self._clock() - self._started) * 1000.0 - self._idle_ms' \
  'return (self._clock() - self._started) * 1000.0' \
  adapters/python/tests

heading "tracing changes the program, and says so"

check "no warning that __del__ will be delayed" "$ANALYSIS" \
  'self.finalizer_lines.append(node.lineno)' 'pass' \
  adapters/python/tests

heading "folding a long loop"

if [ -f adapters/python/flow_view_tracer/collapse.py ]; then
  COLLAPSE=adapters/python/flow_view_tracer/collapse.py
  check "a fold swallows output and exceptions" "$COLLAPSE" \
    'if kind not in FOLDABLE:' 'if False:' \
    adapters/python/tests
  check "metric deltas dropped when folding" "$COLLAPSE" \
    'self.metrics[name] = self.metrics.get(name, 0) + int(payload.get("delta", 1))' \
    'pass' \
    adapters/python/tests
else
  echo "  skipped: loop collapsing is not on this branch"
fi

heading "the JavaScript adapter"

JS_INSTRUMENT=adapters/javascript/src/instrument.js
JS_RUNTIME=adapters/javascript/src/runtime.js
JS_COLLAPSE=adapters/javascript/src/collapse.js
JS_CLI=adapters/javascript/src/cli.js

# The worst bug found while building this adapter: naming an out-of-scope variable in inserted code does not
# make the trace slightly wrong, it throws a ReferenceError and kills the program being watched.
check_corpus "a block treated as part of its enclosing scope" "$JS_INSTRUMENT" \
  'const inner = childScope(scope);' \
  'const inner = scope;'

check_vitest "a block treated as part of its enclosing scope (unit)" "$JS_INSTRUMENT" \
  'const inner = childScope(scope);' \
  'const inner = scope;' \
  adapters/javascript/test/instrument.test.js

# A for loop whose counter appears nowhere is a strange thing for a tool that exists to show loops running.
check_vitest "a loop's own variable left out of its body" "$JS_INSTRUMENT" \
  'if (header && header.type === "VariableDeclaration") declare(bodyScope, header);' \
  'if (false) declare(bodyScope, header);' \
  adapters/javascript/test/instrument.test.js

# Frames numbered per function rather than per call made every level of a recursion share one id, and the
# innermost return overwrote the rest: fact(4) reported returning 1.
check_corpus "one frame id shared by every recursive call" "$JS_RUNTIME" \
  'const frame = this.nextFrame++;' \
  'const frame = 1;'

check_vitest "one frame id shared by every recursive call (unit)" "$JS_RUNTIME" \
  'const frame = this.nextFrame++;' \
  'const frame = 1;' \
  adapters/javascript/test/runtime.test.js

# Aliasing is only visible as "the object one name points at grew". If growth looks like construction there
# is nothing left to see.
check_corpus "an object growing reported as an object being built" "$JS_RUNTIME" \
  'op: had ? "set" : seen ? "append" : "set",' \
  'op: "set",'

# Following only changed slots hid `head.next.next = ...`, because head.next still pointed at the same object.
check_corpus "the heap walk stopping at an unchanged reference" "$JS_RUNTIME" \
  'if (!isAtomic(slot)) children.push(slot);' \
  'if (!isAtomic(slot) && !(before.has(key) && sameValue(before.get(key), slot))) children.push(slot);'

check_vitest "the heap walk stopping at an unchanged reference (unit)" "$JS_RUNTIME" \
  'if (!isAtomic(slot)) children.push(slot);' \
  'if (!isAtomic(slot) && !(before.has(key) && sameValue(before.get(key), slot))) children.push(slot);' \
  adapters/javascript/test/runtime.test.js

check_corpus "a loop ended by break reported as ended by its condition" "$JS_RUNTIME" \
  'if (kind === "break") this.pendingJump = "break";' \
  'if (false) this.pendingJump = "break";'

check_vitest "one exception reported once per frame it crosses" "$JS_RUNTIME" \
  'if (this.unwinding !== NOTHING && Object.is(this.unwinding, error)) return;' \
  'if (false) return;' \
  adapters/javascript/test/runtime.test.js

# A truncated run still has to close what it opened, and emission is switched off when a budget bites.
# $'...' so the newline is a real one: _mutate.py replaces text literally and does not read escapes.
check_corpus "a truncated run leaving its frames open" "$JS_RUNTIME" \
  $'  seal() {\n    this.stopped = false;' \
  $'  seal() {\n    if (false) this.stopped = false;'

check_vitest "a fold swallowing output and exceptions" "$JS_COLLAPSE" \
  'if (!FOLDABLE.has(kind)) {' \
  'if (false) {' \
  adapters/javascript/test/collapse.test.js

check_vitest "work discarded along with the steps that did it" "$JS_COLLAPSE" \
  'this.metrics.set(name, (this.metrics.get(name) ?? 0) + Number(delta));' \
  'void name; void delta;' \
  adapters/javascript/test/collapse.test.js

check_vitest "folding before numbering, so seq and step stay dense" "$JS_RUNTIME" \
  'if (STEPPABLE.has(kind)) {' \
  'if (true) {' \
  adapters/javascript/test/runtime.test.js

# Claiming a guard that is not in force is worse than having none: it is the reason someone stops being
# careful. Node has no network permission scope, so this sentence was never true.
check "a guard claimed that node does not enforce" "$JS_CLI" \
  '  guards.push("network NOT restricted: node has no permission scope for it");' \
  '  guards.push("network refused");' \
  apps/server/tests

# Node dies with a trap before running a line if RLIMIT_AS is applied to it.
check "node given an address-space ceiling it cannot boot under" "$RUNNER" \
  '        address_space_rlimit=False,' \
  '        address_space_rlimit=True,' \
  apps/server/tests

# pnpm hoists dependencies, so the nearest node_modules is a tree of symlinks and the packages live higher up.
check "only the nearest node_modules granted to node" "$RUNNER" \
  $'            paths.append(modules.resolve())\n    return paths' \
  $'            paths.append(modules.resolve())\n            break\n    return paths' \
  apps/server/tests

heading "gates that cannot lie"

# Checked by planting the condition rather than by mutating code: the guard is about what is on disk.
CHECKED=$((CHECKED + 1))
cp conformance/.traces/001-assignment.python.json conformance/.traces/999-from-elsewhere.python.json
# Captured before matching, not piped straight into grep.
#
# `set -o pipefail` plus `grep -q` is a trap: grep exits the moment it matches, the producer is killed
# by SIGPIPE, and pipefail reports *that* (141) as the pipeline's status. So `if cmd | grep -q x` is
# false precisely when x was found. Both of these checks reported SURVIVED for that reason alone, which
# is a script that lies about the scripts that lie.
planted="$(timeout "$RUN_TIMEOUT" pnpm exec vitest run conformance/test/replay.test.ts 2>&1)"
if echo "$planted" | grep -q "left over from another run"; then
  printf '  \033[32mcaught\033[0m   %-52s\n' "a trace left behind by another branch"
else
  printf '  \033[31mSURVIVED\033[0m %-52s\n' "a trace left behind by another branch"
  SURVIVORS=$((SURVIVORS + 1))
fi
rm -f conformance/.traces/999-from-elsewhere.python.json

CHECKED=$((CHECKED + 1))
mv conformance/.traces/manifest.json conformance/.traces/manifest.hidden
unmanifested="$(timeout "$RUN_TIMEOUT" pnpm exec vitest run conformance/test/replay.test.ts 2>&1)"
if echo "$unmanifested" | grep -q "no way to tell which traces"; then
  printf '  \033[32mcaught\033[0m   %-52s\n' "recorded traces with no manifest"
else
  printf '  \033[31mSURVIVED\033[0m %-52s\n' "recorded traces with no manifest"
  SURVIVORS=$((SURVIVORS + 1))
fi
mv conformance/.traces/manifest.hidden conformance/.traces/manifest.json

if [ "$QUICK" -eq 0 ]; then
  heading "the two former flakes, repeated"
  # Both used to fail intermittently, so one green run says nothing. Run often enough that the old
  # rates would almost certainly show: the backend disagreement was about one run in two, the layout
  # timing about one in four.
  fails=0
  for _ in $(seq 1 15); do
    timeout "$RUN_TIMEOUT" "$PYTHON" -m pytest $PY_SUITE --tb=no -rN >/dev/null 2>&1 || fails=$((fails + 1))
  done
  printf '  python suite:     %2d failures in 15 runs   (was ~1 in 2)\n' "$fails"
  [ "$fails" -gt 0 ] && SURVIVORS=$((SURVIVORS + 1))

  tfails=0
  for _ in $(seq 1 8); do
    timeout "$RUN_TIMEOUT" pnpm exec vitest run >/dev/null 2>&1 || tfails=$((tfails + 1))
  done
  printf '  typescript suite: %2d failures in 8 runs    (was ~1 in 4)\n' "$tfails"
  [ "$tfails" -gt 0 ] && SURVIVORS=$((SURVIVORS + 1))
fi

restore_all
printf '\n\033[1mresult\033[0m\n'
printf '  %d checks, %d survivors\n' "$CHECKED" "$SURVIVORS"
if [ "$SURVIVORS" -gt 0 ]; then
  echo "  a survivor means a fix has no test that fails without it" >&2
  exit 1
fi
echo "  every fix is held up by a test that fails without it"
