/**
 * Folding the middle of a long loop, in flight.
 *
 * A port of the Python adapter's collapser, deliberately kept line-for-line recognisable against it. This
 * is a pure transform over schema events — it never looks at a JavaScript value — so the two
 * implementations can be read side by side, and the conformance corpus holds both to the same guarantees.
 *
 * (Two implementations of one algorithm is a cost, not a feature. The alternative was to collapse once, in
 * the server, for every adapter — but the Lite profile runs the adapter in a browser worker with no server
 * to pass through, so a trace would fold or not depending on where it ran. The corpus is what keeps these
 * two honest: case 016 runs against both, and the TypeScript replay suite checks the collapsed traces from
 * both for backward-steppability.)
 *
 * A million-iteration loop produces tens of millions of events. Nobody wants to look at them and no browser
 * wants to hold them, but the last thing the loop did still has to be exact — you cannot show someone a
 * summary and then be unable to tell them what `total` ended up as.
 *
 * So the middle is folded into a single **composite invertible step**. A `collapse` event carries the net
 * before and after value of every slot the folded span touched, which is what lets the TraceStore step
 * *backward* across a fold without the events that made it up. Mutations carry `prev`, so the net effect of
 * a span is simply: the first write's `prev`, and the last write's `value`.
 *
 * Three properties this has to keep, in order of how badly they hurt when broken:
 *
 * 1. **Nothing is lost.** Program output, questions asked, exceptions raised and objects created are
 *    visible behaviour. A fold that swallowed them would make the trace a lie, so a span containing
 *    anything this cannot represent is not folded at all — see `FOLDABLE`.
 * 2. **State is exact.** Replaying a collapsed trace must leave exactly the state an uncollapsed one would.
 * 3. **It streams, with bounded memory.** Waiting for the loop to finish before emitting anything would
 *    defeat the point. Buffering is bounded by the tail window plus one chunk.
 *
 * The shape of the output, for a loop of 1000 with a head and tail of 3:
 *
 *     iterations 0,1,2        verbatim
 *     iterations 3..996       one or more collapse events, emitted as the loop runs
 *     iterations 997,998,999  verbatim
 *
 * The tail is the reason anything is buffered at all: you cannot know an iteration is one of the last three
 * until the loop ends, so the most recent three are held and folded only once a fourth arrives.
 */

/**
 * Events a fold can represent, and therefore swallow.
 *
 * `var_set` and `obj_set` become effects. `metric` deltas are summed onto the collapse event. `step_line`,
 * `branch`, `jump`, `loop_iter` and balanced `frame_push`/`frame_pop` pairs describe *how* the span got
 * there, which is precisely what folding discards.
 *
 * Notably absent: `obj_new`, `stdout`, `stderr`, the `stdin_*` pair, the exception events and `note`. Those
 * are behaviour a summary cannot stand in for, and a loop containing any of them is left alone.
 */
export const FOLDABLE = new Set([
  "step_line",
  "branch",
  "jump",
  "loop_iter",
  "var_set",
  "var_del",
  "obj_set",
  "obj_resize",
  "metric",
  "frame_push",
  "frame_pop",
]);

/** How many iterations to keep in full at each end of a loop. */
export const DEFAULT_KEEP_HEAD = 3;
export const DEFAULT_KEEP_TAIL = 3;

/**
 * Iterations folded into one collapse event before it is emitted and a new one started.
 *
 * This is what keeps the trace streaming. Without it a long loop would emit nothing between its head and
 * its tail, and the effect accumulator would grow with the number of distinct slots touched rather than
 * being flushed periodically.
 */
export const DEFAULT_CHUNK = 2000;

/**
 * Iterations a loop must exceed before folding starts.
 *
 * Below this the fold costs more than it saves: a collapse event carrying two effects is larger than the
 * handful of events it replaces, and a reader would rather see six iterations than four and a summary.
 */
export const DEFAULT_MIN_ITERATIONS = 20;

/** The net effect of a run of iterations, accumulated as they go by. */
class Fold {
  constructor(region, fromSeq) {
    this.region = region;
    this.fromSeq = fromSeq;
    this.iterations = 0;
    this.firstIter = null;
    this.lastIter = null;
    // Keyed by the slot a write lands on. A Map preserves insertion order, which keeps the emitted effects
    // in the order the span first touched them and so keeps traces comparable.
    this.effects = new Map();
    this.metrics = new Map();
  }

  get empty() {
    return this.iterations === 0;
  }

  absorb(kind, payload) {
    if (kind === "loop_iter") {
      this.iterations += 1;
      const index = payload.i;
      if (this.firstIter === null) this.firstIter = index;
      this.lastIter = index;
      return;
    }

    if (kind === "metric") {
      const name = payload.name;
      const delta = payload.delta ?? 1;
      this.metrics.set(name, (this.metrics.get(name) ?? 0) + Number(delta));
      return;
    }

    if (kind === "var_set") {
      this.write(["var", payload.frame, payload.name], payload, false);
      return;
    }

    if (kind === "var_del") {
      // A deletion is a write to nothing. `after` absent is how the store reads "gone".
      this.write(["var", payload.frame, payload.name], payload, true);
      return;
    }

    if (kind === "obj_set") {
      this.write(["obj", payload.obj, String(payload.key)], payload, false);
      return;
    }

    // step_line, branch, jump, frame_push, frame_pop: how the span got here, which is what folding is
    // for. Nothing to record.
  }

  write(slot, payload, deleted) {
    const [kind, owner, key] = slot;
    const id = `${kind}\u0000${owner}\u0000${key}`;
    let effect = this.effects.get(id);

    if (effect === undefined) {
      effect = { kind, key };
      if (kind === "var") {
        if (owner !== undefined && owner !== null) effect.frame = owner;
      } else {
        effect.obj = owner;
      }
      // The first write's `prev` is where the span started. Absent `prev` means the slot did not exist,
      // which is itself the correct `before` — the store reads a missing `before` as "remove this again"
      // when stepping backward.
      if ("prev" in payload) effect.before = payload.prev;
      this.effects.set(id, effect);
    }

    // The last write wins for `after`, which is the whole idea of a net effect.
    if (deleted) delete effect.after;
    else effect.after = payload.value;
  }

  toEvent(toSeq) {
    const payload = {
      region: this.region,
      from_seq: this.fromSeq,
      to_seq: toSeq,
      iterations: this.iterations,
      effects: [...this.effects.values()],
    };
    if (this.firstIter !== null) payload.from_iter = this.firstIter;
    if (this.lastIter !== null) payload.to_iter = this.lastIter;
    if (this.metrics.size > 0) payload.metrics = Object.fromEntries(this.metrics);
    return payload;
  }
}

/** One loop being watched. */
class Region {
  constructor(region) {
    this.region = region;
    this.seen = 0;
    // Completed iterations held back, newest last. Each is a list of its events.
    this.tail = [];
    // The iteration currently being collected, if it is being held back.
    this.current = null;
    this.fold = null;
    // Set when the span turned out to contain something a fold cannot represent. From then on this loop is
    // passed through untouched.
    this.givingUp = false;
    // Call depth inside the buffered iteration, so an unbalanced frame is not folded away.
    this.depth = 0;
  }
}

/**
 * Decides, event by event, what to emit now, what to hold, and what to fold.
 *
 * Pure and synchronous: `feed` returns the events to emit. It owns no clock, no numbering and no output,
 * which is what makes it testable without a running program.
 */
export class LoopCollapser {
  constructor(options = {}) {
    this.keepHead = Math.max(0, options.keepHead ?? DEFAULT_KEEP_HEAD);
    this.keepTail = Math.max(0, options.keepTail ?? DEFAULT_KEEP_TAIL);
    this.chunk = Math.max(1, options.chunk ?? DEFAULT_CHUNK);
    this.minIterations = Math.max(0, options.minIterations ?? DEFAULT_MIN_ITERATIONS);
    this.seq = options.seq ?? (() => 0);
    this.stack = [];
    this.foldedIterations = 0;
    this.collapseEvents = 0;
  }

  /**
   * Return the events to emit in place of this one.
   *
   * @param {string} kind
   * @param {object} [payload]
   * @returns {Array<[string, object]>}
   */
  feed(kind, payload) {
    const data = payload ?? {};

    if (kind === "loop_enter") {
      const out = this.flushAllBuffers();
      this.stack.push(new Region(Number(data.region)));
      out.push([kind, data]);
      return out;
    }

    if (kind === "loop_exit") {
      const out = this.close(Number(data.region));
      out.push([kind, data]);
      return out;
    }

    const active = this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
    if (active === null || active.givingUp) return [[kind, data]];

    if (kind === "loop_iter" && Number(data.region ?? -1) === active.region) {
      return this.beginIteration(active, data);
    }

    // Everything else belongs to whichever iteration is open.
    if (active.current === null) return [[kind, data]];

    if (!FOLDABLE.has(kind)) {
      // Output, a question, an exception, a new object: real behaviour this cannot summarise.
      return this.giveUp(active, [kind, data]);
    }

    if (kind === "frame_push") {
      active.depth += 1;
    } else if (kind === "frame_pop") {
      active.depth -= 1;
      if (active.depth < 0) {
        // A return out of the loop's own frame. Folding across it would erase a frame change.
        return this.giveUp(active, [kind, data]);
      }
    }

    active.current.push([kind, data]);
    return [];
  }

  // -- iteration boundaries ------------------------------------------------

  beginIteration(active, data) {
    const out = [];

    // Close the iteration that was open.
    if (active.current !== null) {
      if (active.depth !== 0) return this.giveUp(active, ["loop_iter", data]);
      active.tail.push(active.current);
      active.current = null;
    }

    active.seen += 1;

    // The head runs verbatim, and so does everything until the loop proves it is long enough to be worth
    // folding at all.
    if (active.seen <= this.keepHead || active.seen <= this.minIterations) {
      out.push(...this.drainTail(active));
      out.push(["loop_iter", data]);
      return out;
    }

    // Past the head: hold this iteration back, and fold the oldest held one once the tail window is full.
    // This is the only reason anything is buffered — an iteration cannot be known to be among the last few
    // until the loop ends.
    active.current = [["loop_iter", data]];
    active.depth = 0;
    while (active.tail.length > this.keepTail) {
      out.push(...this.foldOldest(active));
    }
    return out;
  }

  foldOldest(active) {
    const oldest = active.tail.shift();
    if (active.fold === null) active.fold = new Fold(active.region, this.seq());
    for (const [kind, payload] of oldest) active.fold.absorb(kind, payload);
    this.foldedIterations += 1;
    if (active.fold.iterations >= this.chunk) return this.emitFold(active);
    return [];
  }

  emitFold(active) {
    const fold = active.fold;
    active.fold = null;
    if (fold === null || fold.empty) return [];
    this.collapseEvents += 1;
    return [["collapse", fold.toEvent(this.seq())]];
  }

  /** Emit held iterations verbatim, after whatever has been folded so far. */
  drainTail(active) {
    const out = this.emitFold(active);
    for (const iteration of active.tail) out.push(...iteration);
    active.tail.length = 0;
    return out;
  }

  // -- closing out ---------------------------------------------------------

  close(region) {
    const out = [];
    while (this.stack.length > 0) {
      const active = this.stack.pop();
      if (active.current !== null) {
        active.tail.push(active.current);
        active.current = null;
      }
      out.push(...this.drainTail(active));
      if (active.region === region) break;
    }
    return out;
  }

  /**
   * Abandon folding this loop, emitting everything held in the order it happened.
   *
   * Correctness first. A loop that prints, raises, asks a question or allocates is left alone rather than
   * summarised approximately: the step and output budgets are what bound those, not this.
   */
  giveUp(active, event) {
    active.givingUp = true;
    const out = [];
    // Anything already folded still has to be described, or its state changes vanish.
    out.push(...this.emitFold(active));
    for (const iteration of active.tail) out.push(...iteration);
    active.tail.length = 0;
    if (active.current !== null) {
      out.push(...active.current);
      active.current = null;
    }
    out.push(event);
    return out;
  }

  flushAllBuffers() {
    const out = [];
    for (const active of this.stack) out.push(...this.drainTail(active));
    return out;
  }

  /** Everything still held, for the end of a run that never closed its loops. */
  drain() {
    const out = [];
    while (this.stack.length > 0) {
      const active = this.stack.pop();
      if (active.current !== null) {
        active.tail.push(active.current);
        active.current = null;
      }
      out.push(...this.drainTail(active));
    }
    return out;
  }
}
