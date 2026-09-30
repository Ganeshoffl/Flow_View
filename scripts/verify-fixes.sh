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

# check_corpus <label> <file> <old> <new> [language]
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
  # Narrowed to the language whose adapter was mutated, worked out from where the file lives. Running all three
  # to find out about one of them took long enough that the gate could not finish in a single sitting, and a
  # mutation to the JavaScript adapter has nothing to say about Python's cases.
  local narrow=""
  case "$file" in
    adapters/javascript/*) narrow="--language javascript" ;;
    adapters/java/*) narrow="--language java" ;;
  esac

  local out status
  # shellcheck disable=SC2086 - narrow is a deliberately word-split flag pair or empty.
  out="$(timeout "$RUN_TIMEOUT" "$PYTHON" conformance/runner.py $narrow 2>&1)"
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
  # A narrowed run writes no traces, so there is nothing to put back. A full one does, and a mutated full run
  # would leave mutated traces behind for the replay suite to read.
  if [ -z "$narrow" ]; then
    timeout "$RUN_TIMEOUT" "$PYTHON" conformance/runner.py >/dev/null 2>&1
  fi
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
  'const inner = scope;' \
  javascript

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
  'const frame = 1;' \
  javascript

check_vitest "one frame id shared by every recursive call (unit)" "$JS_RUNTIME" \
  'const frame = this.nextFrame++;' \
  'const frame = 1;' \
  adapters/javascript/test/runtime.test.js

# Aliasing is only visible as "the object one name points at grew". If growth looks like construction there
# is nothing left to see.
check_corpus "an object growing reported as an object being built" "$JS_RUNTIME" \
  'op: had ? "set" : seen ? "append" : "set",' \
  'op: "set",' \
  javascript

# Following only changed slots hid `head.next.next = ...`, because head.next still pointed at the same object.
check_corpus "the heap walk stopping at an unchanged reference" "$JS_RUNTIME" \
  'if (!isAtomic(slot)) children.push(slot);' \
  'if (!isAtomic(slot) && !(before.has(key) && sameValue(before.get(key), slot))) children.push(slot);' \
  javascript

check_vitest "the heap walk stopping at an unchanged reference (unit)" "$JS_RUNTIME" \
  'if (!isAtomic(slot)) children.push(slot);' \
  'if (!isAtomic(slot) && !(before.has(key) && sameValue(before.get(key), slot))) children.push(slot);' \
  adapters/javascript/test/runtime.test.js

check_corpus "a loop ended by break reported as ended by its condition" "$JS_RUNTIME" \
  'if (kind === "break") this.pendingJump = "break";' \
  'if (false) this.pendingJump = "break";' \
  javascript

check_vitest "one exception reported once per frame it crosses" "$JS_RUNTIME" \
  'if (this.unwinding !== NOTHING && Object.is(this.unwinding, error)) return;' \
  'if (false) return;' \
  adapters/javascript/test/runtime.test.js

# A truncated run still has to close what it opened, and emission is switched off when a budget bites.
# $'...' so the newline is a real one: _mutate.py replaces text literally and does not read escapes.
# A frame parked at an `await` is open but not running. Treating the top of the stack as "where we are" made two
# concurrent calls look like one nested inside the other, and like recursion because they share a name.
check_corpus "a suspended call treated as the one that is running" "$JS_RUNTIME" \
  '      if (!this.frames.get(id)?.suspended) return id;' \
  '      return id;'

# A program whose last statement is `main()` leaves its real work queued. Closing the trace when the module body
# returns reported success while the output had not happened yet.
check_corpus "the trace closed before the program finished" "$JS_CLI" \
  '    await settled(tracer, args.wallMs);' \
  '    if (false) await settled(tracer, args.wallMs);'

check_corpus "a truncated run leaving its frames open" "$JS_RUNTIME" \
  $'  seal() {\n    this.stopped = false;' \
  $'  seal() {\n    if (false) this.stopped = false;' \
  javascript

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
  apps/server/tests -k JavaScript

# Node dies with a trap before running a line if RLIMIT_AS is applied to it.
check "node given an address-space ceiling it cannot boot under" "$RUNNER" \
  $'        env={},\n        address_space_rlimit=False,' \
  $'        env={},\n        address_space_rlimit=True,' \
  apps/server/tests -k JavaScript

# pnpm hoists dependencies, so the nearest node_modules is a tree of symlinks and the packages live higher up.
check "only the nearest node_modules granted to node" "$RUNNER" \
  $'            paths.append(modules.resolve())\n    return paths' \
  $'            paths.append(modules.resolve())\n            break\n    return paths' \
  apps/server/tests -k JavaScript

heading "the Java adapter"

JAVA_TRACER=adapters/java/src/FlowViewTracer.java

# An assignment is only visible after the line that made it, so the line it is attributed to is the line that
# just finished — and a method's *first* statement needs the frame seeded from its entry location, or every
# method's opening assignment is reported one line late.
check "an assignment blamed on the line after it" "$JAVA_TRACER" \
  'pushed.line = event.location().lineNumber();' \
  'pushed.line = 0;' \
  apps/server/tests -k "Java and not JavaScript"

# JDI reports no method exit for a method that throws, so the frame stack has to be checked rather than trusted.
# Note this no longer *crashes* — observe() reads the variable table of the method actually running, so the only
# symptom left is a trace attributing everything after the throw to a method that is no longer on the stack.
check "the frame stack trusted while an exception unwinds" "$JAVA_TRACER" \
  '        if (suspect) {
            reconcile(emitter, state, event.thread());' \
  '        if (false) {
            reconcile(emitter, state, event.thread());' \
  apps/server/tests -k "Java and not JavaScript"

# A body line containing a call is stepped twice per pass: into the call, and again on the way back.
check "a loop counting the call in its body as another iteration" "$JAVA_TRACER" \
  'if (frame.line != line) {' \
  'if (true) {' \
  apps/server/tests -k "Java and not JavaScript"

# Strings and boxed primitives are values to everyone except the JVM.
check "the JDK's own bookkeeping shown as the program's data" "$JAVA_TRACER" \
  'if (value instanceof StringReference) return true;' \
  'if (false) return true;' \
  apps/server/tests -k "Java and not JavaScript"

# A collection is library code, and the rule that hides library internals would hide its contents too.
check "a list's contents hidden as library internals" "$JAVA_TRACER" \
  'Map<String, Value> collection = collectionSlots(reference);' \
  'Map<String, Value> collection = null;' \
  apps/server/tests -k "Java and not JavaScript"

# A single-line infinite loop never changes line, so no further events ever arrive and an unbounded wait hangs.
# Reverting this is expected to be caught *by hanging*, which the harness reports distinctly.
check "waiting for an event that will never arrive" "$JAVA_TRACER" \
  'EventSet set = queue.remove(POLL_MS);' \
  'EventSet set = queue.remove();' \
  apps/server/tests -k "Java and not JavaScript"

# Reading state only when the source says it could have changed is what makes Java 1.5x faster. The danger is
# not that it is slow, it is that it skips something it should have read.
check "state left unread after a line that changed it" "$JAVA_TRACER" \
  '            return parsed && !assigning.contains(line) && !mutating.contains(line);' \
  '            return true;' \
  apps/server/tests -k "Java and not JavaScript"

check "the heap left unread after a line that mutated it" "$JAVA_TRACER" \
  '            return !parsed || mutating.contains(line);' \
  '            return false;' \
  apps/server/tests -k "Java and not JavaScript"

# Folding hides steps, not effort. A metrics pane fed only the surviving events would under-report the work.
check "work discarded along with the steps that did it" "$JAVA_TRACER" \
  '                        metrics.merge(name, delta, Long::sum);' \
  '                        if (false) metrics.merge(name, delta, Long::sum);' \
  apps/server/tests -k "Java and not JavaScript"

# The whole point of a fold: it must carry where the span started and where it ended, or a reader can step
# forward over it and never back.
check "a fold that forgets the state it passed through" "$JAVA_TRACER" \
  '                if (deleted) effect.remove("after");
                else effect.put("after", payload.get("value"));' \
  '                if (deleted) effect.remove("after");' \
  apps/server/tests -k "Java and not JavaScript"

# The `java` on PATH is usually a version manager's shim, which cannot resolve itself in a scrubbed environment.
# Neither the tracer's JVM nor the program's can start inside the address-space ceiling every other child gets.
check "two JVMs given an address-space ceiling they cannot boot under" "$RUNNER" \
  $'        # heap cap, by the tracer.\n        address_space_rlimit=False,' \
  $'        # heap cap, by the tracer.\n        address_space_rlimit=True,' \
  apps/server/tests -k "Java and not JavaScript"

check "a version manager's shim used instead of the real java" "$RUNNER" \
  '    java = java_executable()' \
  '    java = shutil.which("java")' \
  apps/server/tests -k "Java and not JavaScript"

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
