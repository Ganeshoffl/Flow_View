/**
 * The runtime the instrumented program calls into, and the trace it produces.
 *
 * Every event here is the same universal trace the Python adapter emits. That is the whole point of the
 * schema: the browser does not know or care which language it is looking at, so `step_line` from here and
 * `step_line` from the Python tracer have to mean exactly the same thing. Where they would differ, the
 * conformance corpus says so out loud rather than letting two dialects drift apart.
 *
 * Deliberately plain ESM with no dependencies. It has to run unchanged inside a browser worker for the
 * Lite profile, which rules out anything Node-specific in this file.
 */

/** Values carried inline in the trace rather than as heap objects. */
function isAtomic(value) {
  if (value === null || value === undefined) return true;
  const kind = typeof value;
  return kind === "boolean" || kind === "number" || kind === "string" || kind === "bigint";
}

/** Encode a primitive the way the schema expects. */
function encodePrimitive(value) {
  if (value === undefined) return { prim: null };
  if (typeof value === "bigint") return { prim: `${value}n` };
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { prim: Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf" };
  }
  return { prim: value };
}

/** Map a live value to a schema ObjKind. */
function classify(value) {
  if (Array.isArray(value)) return "list";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  if (typeof value === "function") return "function";
  return "instance";
}

function typeNameOf(value) {
  if (Array.isArray(value)) return "Array";
  if (typeof value === "function") return value.name ? `function ${value.name}` : "function";
  const ctor = value?.constructor?.name;
  return ctor || "Object";
}

/**
 * Stable ids for live objects.
 *
 * A `Map` keyed on the object itself, so identity is real identity and nothing has to be held alive
 * artificially — unlike the Python adapter, which keys on `id()` and therefore has to pin objects to stop
 * an address being recycled. JavaScript has no such problem, so this adapter does not inherit the cost:
 * finalizer timing and weak references are simply not an issue here.
 */
class Registry {
  constructor(onNew) {
    this.ids = new Map();
    this.next = 1;
    this.onNew = onNew;
  }

  idFor(value) {
    const existing = this.ids.get(value);
    if (existing !== undefined) return existing;
    const assigned = this.next++;
    this.ids.set(value, assigned);
    this.onNew?.(assigned, value);
    return assigned;
  }

  known(value) {
    return this.ids.has(value);
  }
}

export class Tracer {
  /**
   * @param {{ path?: string, lineCount?: number, emit: (event: object) => void, limits?: object }} options
   */
  constructor(options) {
    this.path = options.path ?? "main.js";
    this.emitEvent = options.emit;
    this.limits = {
      maxSteps: options.limits?.maxSteps ?? 200000,
      wallMs: options.limits?.wallMs ?? 30000,
      outputBytes: options.limits?.outputBytes ?? 1048576,
    };

    this.seq = 0;
    this.step = 0;
    this.lineCount = options.lineCount ?? 0;
    this.started = performance.now();
    this.stopped = false;
    this.sealed = false;
    this.stopReason = null;
    this.outputBytes = 0;
    // Time spent blocked on input, which is not the program's doing and is not charged to it.
    this.idleMs = 0;

    // Per frame: the last values seen, so a scan can report what moved.
    this.frames = new Map();
    this.stack = [];
    // Frame ids are allocated here rather than at instrumentation time. A source has one `fact` function
    // but a run of it has four *calls*, and the schema is explicit that ids are "unique for the whole run
    // and never reused, so recursion yields a distinct frame per depth".
    this.nextFrame = 0;
    this.loops = new Map();
    // A `break` is observed one event before the loop ends, and the loop is what has to report it.
    this.pendingJump = null;
    // Folding long loops, if asked for. The collapser stamps from_seq/to_seq onto the spans it folds, and
    // only this object knows what the next sequence number will be.
    this.collapser = options.collapser ?? null;
    if (this.collapser !== null) this.collapser.seq = () => this.seq;

    this.registry = new Registry((id, value) => this.announce(id, value));
    this.slots = new Map();
    this.notesSent = new Set();
    // The exception currently unwinding, so it is reported once however many frames it crosses.
    this.unwinding = NOTHING;
    this.unwindingStack = null;
  }

  // -- emission ------------------------------------------------------------

  /**
   * How long the program has been running, not counting time it spent waiting for a human.
   *
   * The wall-clock budget exists to stop runaway programs. A person taking twenty seconds to read a question
   * and type an answer is not a runaway program, and charging that time to the run would kill it for the one
   * thing it was explicitly built to allow.
   */
  elapsedMs() {
    return performance.now() - this.started - this.idleMs;
  }

  discountIdle(ms) {
    this.idleMs += ms;
  }

  /**
   * Offer one event to the trace.
   *
   * With a collapser attached, events pass through it first. That happens *before* numbering on purpose: a
   * folded event never receives a `seq` or a `step`, so both stay dense and a collapsed trace is
   * indistinguishable from one that was short to begin with. Numbering first and folding second would leave
   * gaps, and every reader that walks a trace by sequence would trip over them.
   */
  emit(kind, payload) {
    if (this.stopped) return;
    if (this.collapser === null) {
      this.write(kind, payload);
      return;
    }
    for (const [outKind, outPayload] of this.collapser.feed(kind, payload)) {
      this.write(outKind, outPayload);
    }
  }

  write(kind, payload) {
    const event = { seq: this.seq++, t: kind, ...payload, ms: round(this.elapsedMs()) };
    if (STEPPABLE.has(kind)) {
      event.step = this.step++;
    }
    this.emitEvent(event);
  }

  /**
   * Close frames the program never came back to.
   *
   * A call parked on a promise nothing ever resolves has not returned, and never will. The schema has a word for
   * exactly this — `implicit` — which is more honest than claiming it returned: a frame that was opened and never
   * accounted for would leave anyone tracking the call stack waiting for an end that is not coming.
   */
  closeAbandoned() {
    for (const frame of [...this.stack].reverse()) {
      const state = this.frames.get(frame);
      this.frames.delete(frame);
      this.emit("frame_pop", {
        frame,
        reason: "implicit",
        line: state?.line ?? 1,
      });
    }
    this.stack.length = 0;
  }

  /** Emit anything the collapser is still holding. Called once, as the run ends. */
  drainCollapser() {
    if (this.collapser === null) return;
    const collapser = this.collapser;
    this.collapser = null;
    for (const [kind, payload] of collapser.drain()) this.write(kind, payload);
  }

  note(level, text) {
    if (this.notesSent.has(text)) return;
    this.notesSent.add(text);
    this.emit("note", { level, text });
  }

  checkBudget() {
    if (this.stopped || this.sealed) return;
    if (this.step >= this.limits.maxSteps) this.stop("step_limit");
    else if (this.elapsedMs() >= this.limits.wallMs) this.stop("timeout");
  }

  stop(reason) {
    this.stopReason = reason;
    this.note("warn", reason === "timeout"
      ? `Stopped after ${this.limits.wallMs}ms. The trace up to here is complete.`
      : `Stopped after ${this.limits.maxSteps} steps. The trace up to here is complete.`);
    this.stopped = true;

    // Every frame still open is about to be unwound by the throw below. Saying so here is what lets a
    // loop these frames abandon be reported as ending abnormally rather than as having returned.
    for (const open of this.stack) {
      const state = this.frames.get(open);
      if (state) state.threw = true;
    }
    throw new BudgetExceeded(reason);
  }

  /**
   * Re-open emission for the events that close a truncated run.
   *
   * Hitting a budget stops the program, but the *trace* still has to be well formed: a frame that was
   * pushed has to be popped, and a run has to say how it ended. Without this, stopping a program mid-loop
   * left frames open forever and any reader tracking the call stack would wait for a pop that never came.
   *
   * Budget checks are disabled from here on rather than merely passed, so the shutdown path cannot trip
   * the same limit a second time and stop itself.
   */
  seal() {
    this.stopped = false;
    this.sealed = true;
  }

  // -- the calls the instrumented program makes ----------------------------

  start() {
    this.emit("run_start", {});
  }

  /**
   * The frame the instrumented program is currently inside.
   *
   * For synchronous code this is exactly the top of the stack, which is why the instrumented program does
   * not pass a frame id around: there is only ever one right answer and the runtime already knows it.
   * Async would break that assumption, and the adapter declines to guess rather than emitting a trace
   * whose frames are quietly wrong.
   */
  /**
   * The innermost frame that is actually *running*.
   *
   * Not simply the top of the stack. A function suspended at an `await` is still open — it has not returned — but
   * it is not executing, and whatever runs next is not happening inside it. Taking the top of the stack made two
   * concurrent calls look like one nested in the other, and because they share a name, like recursion: the
   * call-stack pane showed a depth that never existed, and the trace said it confidently.
   */
  currentFrame() {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const id = this.stack[i];
      if (!this.frames.get(id)?.suspended) return id;
    }
    return undefined;
  }

  current() {
    const frame = this.currentFrame();
    return frame === undefined ? undefined : this.frames.get(frame);
  }

  /**
   * A call began. Allocates the frame.
   *
   * @param {string} name
   * @param {number} line
   * @param {object} args parameter values, captured by the instrumented prologue
   * @returns {number} the new frame id
   */
  enter(name, line, args) {
    const frame = this.nextFrame++;
    const entries = Object.entries(args ?? {});
    // How many calls to this same function are already in progress below us.
    // Only calls that are *running* count as ancestors. A suspended invocation of the same function is a sibling
    // waiting its turn, not a level of recursion.
    let depth = 0;
    for (const open of this.stack) {
      const state = this.frames.get(open);
      if (state?.name === name && !state.suspended) depth++;
    }
    const caller = this.currentFrame();

    this.frames.set(frame, { previous: new Map(entries), line, name, loops: [] });
    this.stack.push(frame);

    this.emit("frame_push", {
      frame,
      func: name,
      args: entries.map(([argName, value]) => ({ name: argName, value: this.encode(value) })),
      kind: "user",
      recursion_depth: depth,
      line,
      path: this.path,
      ...(caller === undefined ? {} : { caller }),
    });
    this.metric("call");
    return frame;
  }

  /**
   * A function suspended at an `await`. It is still open, but it is no longer running.
   *
   * Passed through rather than acted on, so the awaited value is not touched.
   */
  suspending(frame, value) {
    const state = this.frames.get(frame);
    if (state) state.suspended = true;
    return value;
  }

  /** The await finished and the function is running again. */
  resumed(frame, value) {
    const state = this.frames.get(frame);
    if (state) state.suspended = false;
    return value;
  }

  /**
   * The call finished, however it finished — this runs from a `finally`, so exceptions come here too.
   *
   * The frame is named rather than assumed to be the top of the stack. With concurrent calls the top is whichever
   * one happens to be open, so popping it closed the wrong frame: return values landed on the wrong call and
   * three frames in a four-frame program were never closed at all.
   */
  leave(frame = this.currentFrame()) {
    if (frame === undefined) return;
    const state = this.frames.get(frame);
    if (state === undefined) return;

    // A `return` from inside a loop skips the loopExit that sits after the loop statement, so any region
    // this frame still has open is closed here. Without this the trace would contain a loop_enter with no
    // matching loop_exit, and a reader tracking regions would never see the loop end.
    //
    // Closed before the frame leaves the stack, so the loop_exit is attributed to the frame that owned the
    // loop rather than to whoever called it.
    for (const region of [...(state?.loops ?? [])].reverse()) {
      this.closeLoop(region, state?.threw ? "exception" : "return");
    }

    const at = this.stack.lastIndexOf(frame);
    if (at >= 0) this.stack.splice(at, 1);
    this.frames.delete(frame);

    const returned = state?.returned;
    this.emit("frame_pop", {
      frame,
      reason: "return",
      line: state?.line ?? 1,
      ...(returned === undefined ? {} : { return_value: this.encode(returned) }),
    });
  }

  /**
   * What the current call is about to return.
   *
   * Wrapped around the return expression rather than read afterwards, so the value is observed exactly
   * once. By the time this runs, any call inside the expression has already entered and left, so the top
   * of the stack is this frame again.
   */
  returned(value) {
    const state = this.current();
    if (state) state.returned = value;
    return value;
  }

  line(line) {
    this.checkBudget();
    const state = this.current();
    if (state) state.line = line;
    this.emit("step_line", { frame: this.currentFrame(), line, path: this.path });
  }

  /**
   * The scope after a statement ran. Reports what moved.
   *
   * Diffing rather than instrumenting each assignment, for the reason given in instrument.js: assignment
   * in JavaScript has too many shapes to catch one at a time without silently missing some.
   */
  after(line, values) {
    if (this.stopped || !values) return;
    const frame = this.currentFrame();
    const state = this.frames.get(frame);
    if (!state) return;

    const fresh = [];
    for (const [name, value] of Object.entries(values)) {
      const had = state.previous.has(name);
      const before = state.previous.get(name);
      if (had && sameValue(before, value)) continue;

      const payload = {
        frame,
        name,
        value: this.encode(value),
        scope: "local",
        line,
      };
      if (had) payload.prev = this.encode(before);
      else payload.declared = true;
      this.emit("var_set", payload);
      this.metric("assignment");
      state.previous.set(name, value);
      if (!isAtomic(value)) fresh.push(value);
    }

    // Objects the statement touched, so the heap view has their contents.
    for (const value of fresh) this.walk(value, line);
    for (const value of Object.values(values)) {
      if (!isAtomic(value) && this.registry.known(value)) this.walk(value, line);
    }
  }

  /**
   * A control-flow decision, with the outcome as it actually happened.
   *
   * `kind` is decided at instrumentation time because only the parser can tell an `if` from the `else if`
   * of an enclosing one — at runtime they are the same node shape.
   */
  branch(line, kind, expression, outcome) {
    this.emit("branch", {
      frame: this.currentFrame(),
      line,
      kind,
      expr: expression,
      outcome: outcome ? "taken" : "not_taken",
    });
    this.metric("comparison");
    return outcome;
  }

  /**
   * A `break` or `continue` is about to move control.
   *
   * Recorded as well as emitted: the loop that is being broken out of only finds out afterwards, when
   * `loopExit` runs, and "why did this loop stop" is the question the loop event has to answer.
   */
  jump(line, kind) {
    this.emit("jump", { frame: this.currentFrame(), line, kind });
    if (kind === "break") this.pendingJump = "break";
  }

  /**
   * Report an exception the first time it is seen, and only then.
   *
   * One exception crossing five frames is one exception, and the corpus says so in as many words. The
   * "have we met" test is identity against the exception currently unwinding rather than a set of every
   * error ever seen: execution here is synchronous and single-threaded, so at most one exception is in
   * flight at a time. A handler that throws something new clears the old one first, which is exactly
   * right — that is genuinely a second exception.
   *
   * Identity rather than a `WeakSet` also means `throw 'a string'` and `throw undefined` work, which are
   * legal JavaScript and could not be put in a `WeakSet` at all.
   */
  noticeRaise(error) {
    // The budget stop is this tracer's own control flow, not something the program did. Reporting it as
    // the program raising would turn "your loop was too long" into "your program crashed".
    if (error instanceof BudgetExceeded) return;
    if (this.unwinding !== NOTHING && Object.is(this.unwinding, error)) return;

    this.unwinding = error;
    // Captured here, while the frames that were running still exist. By the time an uncaught exception
    // reaches the top, every `finally` has run and the stack is empty.
    this.unwindingStack = this.snapshotStack();

    const state = this.current();
    this.emit("exception_raise", {
      frame: this.currentFrame(),
      line: state?.line,
      path: this.path,
      type: typeNameOfError(error),
      message: messageOfError(error),
    });
  }

  /** An exception was caught, so it is no longer in flight. */
  caught(line, error) {
    if (arguments.length > 1) this.noticeRaise(error);
    const frame = this.currentFrame();
    this.emit("exception_catch", { frame, line, path: this.path, handler_line: line });
    this.unwinding = NOTHING;
  }

  /** An exception passed through the current frame on its way out. */
  threw(error) {
    this.noticeRaise(error);
    const state = this.current();
    if (state) state.threw = true;
  }

  /** The frames currently running, innermost first, as a rendered stack. */
  snapshotStack() {
    const entries = [];
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const state = this.frames.get(this.stack[i]);
      entries.push({
        func: state?.name ?? "<unknown>",
        path: this.path,
        line: state?.line ?? 1,
      });
    }
    return entries;
  }

  loopEnter(region, lineStart, lineEnd) {
    this.loops.set(region, 0);
    this.current()?.loops.push(region);
    this.emit("loop_enter", {
      frame: this.currentFrame(),
      region,
      line_start: lineStart,
      line_end: lineEnd,
    });
  }

  loopIter(region) {
    const count = (this.loops.get(region) ?? 0) + 1;
    this.loops.set(region, count);
    this.emit("loop_iter", { frame: this.currentFrame(), region, i: count - 1 });
    this.metric("iteration");
  }

  /** Control reached the statement after the loop, so the loop is over. */
  loopExit(region) {
    const reason = this.pendingJump === "break" ? "break" : "condition";
    this.pendingJump = null;
    this.closeLoop(region, reason);
  }

  closeLoop(region, reason) {
    if (!this.loops.has(region)) return;
    const count = this.loops.get(region) ?? 0;
    this.loops.delete(region);
    const state = this.current();
    if (state) state.loops = state.loops.filter((open) => open !== region);
    this.emit("loop_exit", { frame: this.currentFrame(), region, iterations: count, reason });
  }

  output(stream, text) {
    const remaining = this.limits.outputBytes - this.outputBytes;
    if (remaining <= 0) {
      this.note("warn", "The program produced more output than the budget allows; the rest is dropped.");
      return;
    }
    const clipped = text.length > remaining ? text.slice(0, remaining) : text;
    this.outputBytes += clipped.length;
    const frame = this.stack[this.stack.length - 1];
    this.emit(stream, {
      text: clipped,
      ...(frame === undefined ? {} : { frame }),
    });
  }

  /**
   * The exception that ended the run.
   *
   * The stack reported is the one captured when the exception was first seen, not the live one. By the time
   * an exception reaches the top of the program every `finally` has already run, so the live stack is empty
   * and would say the program failed nowhere in particular.
   */
  /**
   * The program asked a question. Both the question and the answer are recorded.
   *
   * Recording the answer is what makes a trace replayable without a human present. A trace that said "the
   * program read a line here" and not which line would replay differently every time, and every view
   * downstream would be describing a run that cannot be reproduced.
   *
   * @param {string} message the prompt text, as the program wrote it
   * @param {() => (string | null)} read supplies the answer, blocking until it arrives
   * @returns {string | null} the answer, or null when there is no more input
   */
  ask(message, read) {
    const state = this.current();
    const request = {};
    const frame = this.currentFrame();
    if (frame !== undefined) request.frame = frame;
    if (state?.line) request.line = state.line;
    if (message) request.prompt = message;
    this.emit("stdin_request", request);

    const askedAt = this.elapsedMs();
    const answer = read();
    const waitedMs = round(this.elapsedMs() - askedAt);
    this.discountIdle(waitedMs);

    if (answer === null) {
      // `prompt()` returns null when there is no answer — that is what the browser does when the user
      // cancels, so a program written against the platform already handles it. Python's `input()` raises
      // EOFError instead; each adapter behaves the way its own language does, because the point is to show
      // the program running, not to show it running in some other language's style.
      this.note("warn", "The program asked for input but none was left to give.");
      return null;
    }

    this.emit("stdin_response", {
      text: answer,
      // Derived from how long the read actually blocked rather than assumed. Under the server the wait is
      // a real person; under the conformance runner the answer is already in the pipe.
      source: waitedMs >= WAIT_IS_A_PERSON_MS ? "interactive" : "prefilled",
      waited_ms: waitedMs,
    });
    return answer;
  }

  uncaught(error) {
    this.noticeRaise(error);
    this.emit("exception_uncaught", {
      type: typeNameOfError(error),
      message: messageOfError(error),
      stack: this.unwindingStack ?? this.snapshotStack(),
    });
  }

  finish(status, exitCode) {
    // Emitted even when stopped, so a truncated run still says how it ended.
    this.seal();
    // Anything the collapser is still holding belongs in the trace before the run is declared over.
    this.drainCollapser();
    this.emit("run_end", {
      status: this.stopReason ?? status,
      exit_code: exitCode,
      steps: this.step,
      duration_ms: round(this.elapsedMs()),
    });
  }

  metric(name, delta = 1) {
    this.emit("metric", { name, delta });
  }

  // -- the heap ------------------------------------------------------------

  encode(value) {
    if (isAtomic(value)) return encodePrimitive(value);
    return { ref: this.registry.idFor(value) };
  }

  announce(id, value) {
    const payload = {
      obj: id,
      kind: classify(value),
      type_name: typeNameOf(value),
    };
    const length = lengthOf(value);
    if (length !== undefined) payload.length = length;
    this.emit("obj_new", payload);
    this.metric("allocation");
  }

  /**
   * Read an object's slots and report what changed since last time.
   *
   * The three cases are distinguished the same way the Python adapter distinguishes them, because the
   * schema's `op` means the same thing in both traces:
   *
   * - **First sight of the object**: every slot is `set`. This is the initial fill, not a mutation — a
   *   freshly built `[1, 2, 3]` has not been mutated three times.
   * - **A key that is new on an object we already knew**: `append`. This is what `push`, an assignment to
   *   a fresh property, or a new map entry looks like from the outside.
   * - **A key whose value moved**: `set` with `prev`, so the event can be replayed backwards.
   *
   * Conflating the first two costs the trace the only evidence that a mutation happened at all: aliasing
   * is only observable as "the object one name points at grew", and if growth is indistinguishable from
   * construction there is nothing left to see.
   */
  walk(root, line) {
    if (isAtomic(root)) return;
    // One visited set per scan, so an object reachable by several paths is read once and a cycle
    // terminates. Without it, `node.self = node` would recurse to the depth ceiling on every statement.
    const visited = new Set();
    const budget = { objects: MAX_OBJECTS };
    this.walkFrom(root, line, 0, visited, budget);
    if (budget.objects <= 0) {
      this.note(
        "info",
        `The heap view shows at most ${MAX_OBJECTS} objects per step; some of this structure is not shown.`,
      );
    }
  }

  walkFrom(value, line, depth, visited, budget) {
    if (isAtomic(value) || typeof value === "function") return;
    if (depth > MAX_DEPTH) return;

    const id = this.registry.idFor(value);
    if (visited.has(id)) return;
    visited.add(id);
    if (budget.objects-- <= 0) return;

    const seen = this.slots.has(id);
    const before = this.slots.get(id) ?? new Map();
    const now = new Map();
    const frame = this.currentFrame();
    const children = [];

    for (const [key, slot] of slotsOf(value)) {
      now.set(key, slot);
      // Descent is decided independently of whether this slot changed. Following only changed slots was
      // the bug that hid `head.next.next = new Node(3)`: `head.next` still pointed at the same object, so
      // the walk stopped at it and never looked inside to see that *it* had grown a link.
      if (!isAtomic(slot)) children.push(slot);

      const had = before.has(key);
      const previous = before.get(key);
      if (had && sameValue(previous, slot)) continue;

      const payload = {
        obj: id,
        key,
        value: this.encode(slot),
        // A key that is new on an object we already knew is a mutation; on an object we are seeing for the
        // first time it is just how that object was built.
        op: had ? "set" : seen ? "append" : "set",
      };
      if (had) payload.prev = this.encode(previous);
      if (frame !== undefined) payload.frame = frame;
      if (line !== undefined) payload.line = line;
      this.emit("obj_set", payload);
      this.metric("write");
    }

    for (const key of before.keys()) {
      if (!now.has(key)) {
        const payload = {
          obj: id,
          key,
          value: { prim: null },
          prev: this.encode(before.get(key)),
          op: "delete",
        };
        if (frame !== undefined) payload.frame = frame;
        if (line !== undefined) payload.line = line;
        this.emit("obj_set", payload);
        this.metric("write");
      }
    }

    this.slots.set(id, now);

    for (const child of children) this.walkFrom(child, line, depth + 1, visited, budget);
  }

  header(languageVersion) {
    return {
      schema: "flow_view/trace@1",
      session: {
        id: "local",
        language: "javascript",
        language_version: languageVersion,
        adapter_version: "0.1.0",
        profile: "full",
        source_files: [{ path: this.path, sha256: "0".repeat(64), line_count: this.lineCount ?? 0 }],
        entry: { path: this.path, line: 1 },
        limits: {
          max_steps: this.limits.maxSteps,
          wall_ms: this.limits.wallMs,
          memory_mb: 512,
          output_bytes: this.limits.outputBytes,
        },
        started_at: new Date().toISOString(),
      },
    };
  }
}

export class BudgetExceeded extends Error {}

/**
 * How far the heap view reaches. The same ceilings the Python adapter uses, because a structure that is
 * visible in one language's trace and invisible in another's is a difference nobody chose.
 *
 * These exist for a measured reason: an unbounded walk after every statement was benchmarked at 28ms per
 * step, which is hundreds of times over the budget for a responsive step.
 */
const MAX_DEPTH = 3;
const MAX_OBJECTS = 128;

/**
 * Above this, the read is taken to have been answered by a person rather than by a pipe that was already
 * full. Measured, not assumed — the same threshold the Python adapter uses.
 */
const WAIT_IS_A_PERSON_MS = 250;

/**
 * "No exception is in flight."
 *
 * A distinct sentinel rather than `null` or `undefined`, because `throw null` and `throw undefined` are both
 * legal JavaScript and a tracer that mistook either for "nothing thrown" would drop a real exception.
 */
const NOTHING = Symbol("nothing");

/** What to call the thing that was thrown. JavaScript permits throwing anything at all. */
function typeNameOfError(error) {
  if (error instanceof Error) return error.constructor?.name ?? "Error";
  if (error === null) return "null";
  if (error === undefined) return "undefined";
  const ctor = error?.constructor?.name;
  return ctor ?? typeof error;
}

function messageOfError(error) {
  if (error instanceof Error) return String(error.message);
  try {
    return typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

const STEPPABLE = new Set([
  "step_line",
  "branch",
  "jump",
  "frame_push",
  "frame_pop",
  "exception_raise",
  "exception_catch",
  "collapse",
]);

function round(value) {
  return Math.round(value * 1000) / 1000;
}

/** Identity for primitives, reference identity for objects — the same rule the trace uses. */
function sameValue(a, b) {
  if (isAtomic(a) && isAtomic(b)) return Object.is(a, b);
  return a === b;
}

function lengthOf(value) {
  if (Array.isArray(value) || typeof value === "string") return value.length;
  if (value instanceof Map || value instanceof Set) return value.size;
  return undefined;
}

/** The key/value pairs of an object, capped so one wide object cannot bury the rest. */
function slotsOf(value) {
  const out = [];
  const LIMIT = 32;
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, LIMIT); i++) out.push([String(i), value[i]]);
  } else if (value instanceof Map) {
    let seen = 0;
    for (const [k, v] of value) {
      if (seen++ >= LIMIT) break;
      out.push([typeof k === "object" ? "(object key)" : String(k), v]);
    }
  } else if (value instanceof Set) {
    let seen = 0;
    for (const v of value) {
      if (seen++ >= LIMIT) break;
      out.push([String(seen - 1), v]);
    }
  } else if (typeof value === "object" && value !== null) {
    let seen = 0;
    for (const key of Object.keys(value)) {
      if (seen++ >= LIMIT) break;
      out.push([key, value[key]]);
    }
  }
  return out;
}
