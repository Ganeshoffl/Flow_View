/**
 * The tracer's own bookkeeping.
 *
 * Driven by calling the runtime the way instrumented code would, rather than by running a program. That
 * keeps each property isolated: when "a recursive call gets its own frame" fails, the failure is about frame
 * allocation and nothing else.
 */

import { describe, expect, it } from "vitest";

import { BudgetExceeded, Tracer } from "../src/runtime.js";

function tracerWith(limits = {}) {
  const events = [];
  const tracer = new Tracer({
    path: "main.js",
    emit: (event) => events.push(event),
    limits,
  });
  return { tracer, events, of: (kind) => events.filter((e) => e.t === kind) };
}

describe("frames", () => {
  it("gives every call its own frame, so recursion does not collapse into one", () => {
    // Numbering frames per *function* at instrumentation time made every level of a recursion share an id,
    // and the innermost return overwrote all the others: fact(4) reported returning 1 instead of 24.
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});

    for (const n of [4, 3, 2, 1]) tracer.enter("fact", 1, { n });
    for (const value of [1, 2, 6, 24]) {
      tracer.returned(value);
      tracer.leave();
    }
    tracer.leave();

    const pushes = of("frame_push").filter((e) => e.func === "fact");
    expect(new Set(pushes.map((e) => e.frame)).size).toBe(4);
    expect(pushes.map((e) => e.recursion_depth)).toEqual([0, 1, 2, 3]);

    const pops = of("frame_pop").filter((e) => e.frame !== 0);
    expect(pops.map((e) => e.return_value)).toEqual([
      { prim: 1 },
      { prim: 2 },
      { prim: 6 },
      { prim: 24 },
    ]);
  });

  it("records who called whom", () => {
    const { tracer, of } = tracerWith();
    tracer.start();
    const moduleFrame = tracer.enter("<module>", 1, {});
    const outer = tracer.enter("outer", 2, {});
    tracer.enter("inner", 3, {});

    const pushes = of("frame_push");
    expect(pushes[0].caller).toBeUndefined();
    expect(pushes[1].caller).toBe(moduleFrame);
    expect(pushes[2].caller).toBe(outer);
  });

  it("attributes a statement to the frame that is running", () => {
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.line(1);
    const inner = tracer.enter("f", 5, {});
    tracer.line(6);
    tracer.leave();
    tracer.line(2);

    expect(of("step_line").map((e) => [e.frame, e.line])).toEqual([
      [0, 1],
      [inner, 6],
      [0, 2],
    ]);
  });
});

describe("the heap", () => {
  it("calls an object's initial contents a fill, and a later key an append", () => {
    // Aliasing is only observable as "the object one name points at grew". If growth looked the same as
    // construction there would be nothing left to see.
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});

    const first = [1, 2, 3];
    tracer.after(1, { first });
    first.push(4);
    tracer.after(2, { first });

    const writes = of("obj_set");
    expect(writes.map((e) => [e.key, e.op])).toEqual([
      ["0", "set"],
      ["1", "set"],
      ["2", "set"],
      ["3", "append"],
    ]);
  });

  it("follows a reference that did not change, to find what it points at growing", () => {
    // Descending only into slots whose value had changed hid `head.next.next = ...`: `head.next` still
    // pointed at the same object, so the walk stopped there and never looked inside it.
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});

    const head = { value: 1, next: null };
    tracer.after(1, { head });
    head.next = { value: 2, next: null };
    tracer.after(2, { head });
    head.next.next = { value: 3, next: null };
    tracer.after(3, { head });

    expect(of("obj_new")).toHaveLength(3);

    // The write that matters is the one two levels down: the second node's `next` stopped being null and
    // started pointing at the third. Before the fix this event did not exist, because the walk saw that
    // `head.next` was the same object as before and stopped there.
    const [second, third] = of("obj_new").slice(1).map((e) => e.obj);
    const link = of("obj_set").filter(
      (e) => e.line === 3 && e.obj === second && e.key === "next" && e.value?.ref === third,
    );
    expect(link).toHaveLength(1);
    expect(link[0].prev).toEqual({ prim: null });
  });

  it("survives a cycle", () => {
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    const node = { value: 1 };
    node.self = node;
    expect(() => tracer.after(1, { node })).not.toThrow();
    expect(of("obj_new")).toHaveLength(1);
  });

  it("reports a deletion rather than letting a slot quietly disappear", () => {
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    const bag = { a: 1, b: 2 };
    tracer.after(1, { bag });
    delete bag.b;
    tracer.after(2, { bag });

    const deletes = of("obj_set").filter((e) => e.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].key).toBe("b");
    expect(deletes[0].prev).toEqual({ prim: 2 });
  });
});

describe("variables", () => {
  it("records what a rebinding overwrote", () => {
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.after(1, { n: 1 });
    tracer.after(2, { n: 2 });

    const sets = of("var_set");
    expect(sets[0].declared).toBe(true);
    expect(sets[0].prev).toBeUndefined();
    expect(sets[1].prev).toEqual({ prim: 1 });
    expect(sets[1].value).toEqual({ prim: 2 });
  });

  it("says nothing when nothing moved", () => {
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.after(1, { n: 1 });
    tracer.after(2, { n: 1 });
    expect(of("var_set")).toHaveLength(1);
  });
});

describe("loops", () => {
  it("reports a loop ended by a break as ended by a break", () => {
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.loopEnter(0, 1, 3);
    tracer.loopIter(0);
    tracer.jump(2, "break");
    tracer.loopExit(0);

    expect(of("jump")).toHaveLength(1);
    expect(of("loop_exit")[0].reason).toBe("break");
  });

  it("reports an ordinary loop as ended by its condition", () => {
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.loopEnter(0, 1, 3);
    tracer.loopIter(0);
    tracer.loopExit(0);
    expect(of("loop_exit")[0].reason).toBe("condition");
  });

  it("does not let a continue be mistaken for a break", () => {
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.loopEnter(0, 1, 3);
    tracer.loopIter(0);
    tracer.jump(2, "continue");
    tracer.loopIter(0);
    tracer.loopExit(0);
    expect(of("loop_exit")[0].reason).toBe("condition");
  });

  it("closes a loop abandoned by a return, so no region is left open", () => {
    // The loopExit call sits after the loop statement, which a `return` inside the loop jumps straight past.
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.enter("f", 1, {});
    tracer.loopEnter(0, 2, 4);
    tracer.loopIter(0);
    tracer.returned(7);
    tracer.leave();

    expect(of("loop_enter")).toHaveLength(1);
    expect(of("loop_exit")).toHaveLength(1);
    expect(of("loop_exit")[0].reason).toBe("return");
  });
});

describe("exceptions", () => {
  it("reports one exception once, however many frames it crosses", () => {
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.enter("a", 1, {});
    tracer.enter("b", 2, {});

    const error = new RangeError("nope");
    tracer.threw(error); // innermost
    tracer.leave();
    tracer.threw(error); // and again on the way out
    tracer.leave();
    tracer.caught(9, error);

    expect(of("exception_raise")).toHaveLength(1);
    expect(of("exception_raise")[0].type).toBe("RangeError");
    expect(of("exception_catch")).toHaveLength(1);
  });

  it("treats a second, different exception as a second exception", () => {
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.caught(2, new Error("first"));
    tracer.caught(4, new Error("second"));
    expect(of("exception_raise")).toHaveLength(2);
  });

  it("reports where an uncaught exception happened, not where it surfaced", () => {
    // By the time an uncaught error reaches the top, every `finally` has run and the live stack is empty.
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.enter("deep", 7, {});
    tracer.line(8);

    const error = new TypeError("bad");
    tracer.threw(error);
    tracer.leave();
    tracer.leave();
    tracer.uncaught(error);

    const [report] = of("exception_uncaught");
    expect(report.type).toBe("TypeError");
    expect(report.stack.length).toBeGreaterThan(0);
    expect(report.stack[0]).toMatchObject({ func: "deep", line: 8, path: "main.js" });
  });

  it("can carry a thrown value that is not an Error at all", () => {
    // `throw 'a string'` and `throw undefined` are legal JavaScript.
    const { tracer, of } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.caught(2, "just a string");
    expect(of("exception_raise")[0]).toMatchObject({ type: "String", message: "just a string" });
  });
});

describe("budgets", () => {
  it("stops at the step limit and says so, rather than looking like a crash", () => {
    const { tracer, of } = tracerWith({ maxSteps: 5 });
    tracer.start();
    tracer.enter("<module>", 1, {});

    expect(() => {
      for (let i = 0; i < 100; i++) tracer.line(1);
    }).toThrow(BudgetExceeded);

    expect(of("note").some((e) => e.level === "warn")).toBe(true);
    expect(of("exception_raise")).toHaveLength(0);
  });

  it("can still close the trace after stopping", () => {
    // Emission is switched off when a budget bites, so the shutdown path has to switch it back on or the
    // trace ends with a frame that was pushed and never popped.
    const { tracer, of } = tracerWith({ maxSteps: 5 });
    tracer.start();
    tracer.enter("<module>", 1, {});
    try {
      for (let i = 0; i < 100; i++) tracer.line(1);
    } catch {
      /* expected */
    }

    tracer.seal();
    tracer.leave();
    tracer.finish("ok", 0);

    expect(of("frame_push")).toHaveLength(of("frame_pop").length);
    expect(of("run_end")[0].status).toBe("step_limit");
  });

  it("does not charge time spent waiting for input against the clock", () => {
    const { tracer } = tracerWith({ wallMs: 1000 });
    const before = tracer.elapsedMs();
    tracer.discountIdle(500);
    expect(tracer.elapsedMs()).toBeLessThan(before);
  });
});

describe("output", () => {
  it("stops after the output budget and says it stopped", () => {
    const { tracer, of } = tracerWith({ outputBytes: 10 });
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.output("stdout", "0123456789abcdef");
    tracer.output("stdout", "more");

    const printed = of("stdout").map((e) => e.text).join("");
    expect(printed).toHaveLength(10);
    expect(of("note").some((e) => e.level === "warn")).toBe(true);
  });
});

describe("numbering", () => {
  it("numbers sequences densely and steps only on events worth landing on", () => {
    const { tracer, events } = tracerWith();
    tracer.start();
    tracer.enter("<module>", 1, {});
    tracer.line(1);
    tracer.after(1, { n: 1 });
    tracer.line(2);

    expect(events.map((e) => e.seq)).toEqual([...events.keys()]);

    const stepped = events.filter((e) => "step" in e);
    expect(stepped.map((e) => e.step)).toEqual([...stepped.keys()]);
    // A variable changing is not somewhere you land; the statement that changed it is.
    expect(events.find((e) => e.t === "var_set").step).toBeUndefined();
  });
});
