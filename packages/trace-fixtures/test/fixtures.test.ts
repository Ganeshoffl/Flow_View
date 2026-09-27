/**
 * The Phase 0 gate.
 *
 * Every fixture must be schema-valid, structurally coherent, and — the property that matters most —
 * exactly invertible. Replaying a trace to the end and then stepping all the way back must restore
 * the state it started from, because that is the guarantee backward stepping rests on. If it does
 * not hold here, on traces written by hand, it will not hold on traces produced by a real adapter.
 */

import { describe, expect, it } from "vitest";

import { checkTraceInvariants, validateTrace } from "@flow-view/trace-schema/validate";
import { isRef, prim, valueEquals } from "@flow-view/trace-schema";
import {
  TraceStore,
  captureState,
  compareStates,
  createState,
  currentFrame,
  describeDifferences,
} from "@flow-view/trace-store";
import { FIXTURES, getFixture } from "../src/index.js";

const load = (id: string): TraceStore => {
  const store = new TraceStore();
  store.load(getFixture(id).build());
  return store;
};

describe.each(FIXTURES.map((f) => [f.id, f] as const))("fixture %s", (id, fixture) => {
  const trace = fixture.build();

  it("validates against the schema", () => {
    const result = validateTrace(trace);
    const detail = result.errors
      .slice(0, 6)
      .map((e) => `${e.path}: ${e.message}`)
      .join("\n");
    expect(result.valid, `${id} failed schema validation:\n${detail}`).toBe(true);
  });

  it("satisfies structural invariants", () => {
    const result = checkTraceInvariants(trace);
    const detail = result.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
    expect(result.valid, `${id} violated invariants:\n${detail}`).toBe(true);
  });

  it("has steps to land on", () => {
    const store = new TraceStore();
    store.load(trace);
    expect(store.stepCount).toBeGreaterThan(0);
    expect(store.eventCount).toBeGreaterThanOrEqual(store.stepCount);
  });

  it("is exactly invertible over a full round trip", () => {
    const store = new TraceStore();
    store.load(trace);

    store.fastForward();
    expect(store.isAtEnd).toBe(true);

    store.rewind();
    expect(store.isAtStart).toBe(true);

    const pristine = createState();
    const diffs = compareStates(store.state, pristine);
    expect(diffs.length, `${id} did not return to its initial state.\n${describeDifferences(diffs)}`).toBe(0);
  });

  it("reaches the same state whether stepped forward or rewound to", () => {
    const forward = new TraceStore();
    forward.load(trace);
    const backward = new TraceStore();
    backward.load(trace);
    backward.fastForward();

    // Every event boundary, not only step boundaries: bookkeeping events mutate state too, and an
    // asymmetry in one of them is exactly the kind of bug this catches.
    for (let position = 0; position <= forward.eventCount; position++) {
      forward.seekEvent(position);
      backward.seekEvent(position);
      const diffs = compareStates(forward.state, backward.state);
      expect(
        diffs.length,
        `${id} diverged at event ${position} depending on approach direction.\n` +
          describeDifferences(diffs),
      ).toBe(0);
    }
  });

  it("produces a snapshot that matches replayed state", () => {
    const store = new TraceStore();
    store.load(trace);
    store.fastForward();
    const snapshot = captureState(store.state);
    expect(snapshot.full).toBe(true);
    expect(snapshot.frame_order).toEqual(store.state.frameOrder);
    expect(snapshot.objects.length).toBe(store.state.objects.size);
    expect(snapshot.frames.length).toBe(store.state.frames.size);
  });

  it("walks forward and backward across every step without throwing", () => {
    const store = new TraceStore();
    store.load(trace);
    let forwardSteps = 0;
    while (store.next()) forwardSteps++;
    let backwardSteps = 0;
    while (store.prev()) backwardSteps++;
    expect(forwardSteps).toBeGreaterThan(0);
    expect(backwardSteps).toBeGreaterThan(0);
    expect(store.isAtStart).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Semantics. The checks above prove a trace is well formed; these prove it says
// the right thing about the program it describes.
// ---------------------------------------------------------------------------

describe("assignment", () => {
  it("binds x then y and captures output", () => {
    const store = load("assignment");
    store.fastForward();
    expect(store.lookup("x")).toEqual(prim(1));
    expect(store.lookup("y")).toEqual(prim(3));
    expect(store.state.output.map((o) => o.text).join("")).toBe("3\n");
  });

  it("records no frame for a C builtin", () => {
    // `print` is implemented in C, so CPython creates no Python frame and a real trace shows none.
    // This fixture originally invented one, which Phase 1 caught by running the real adapter — the
    // exact risk of building the UI against hand-written traces first.
    const trace = getFixture("assignment").build();
    const library = trace.events.filter((e) => e.t === "frame_push" && e.kind === "library");
    expect(library).toHaveLength(0);
  });

  it("still attributes the printed output to the line that printed it", () => {
    const store = load("assignment");
    store.fastForward();
    expect(store.state.output.map((chunk) => chunk.text).join("")).toBe("3\n");
  });
});

describe("opaque-library", () => {
  it("shows a pure-Python library call as a single opaque frame", () => {
    const trace = getFixture("opaque-library").build();
    const library = trace.events.filter((e) => e.t === "frame_push" && e.kind === "library");
    expect(library).toHaveLength(1);

    // Nothing between the push and the pop: the interior is deliberately invisible, which is what
    // keeps the user's five lines from being buried under the json module's thousands.
    const pushIndex = trace.events.findIndex((e) => e.t === "frame_push" && e.kind === "library");
    expect(trace.events[pushIndex + 1]?.t).toBe("frame_pop");
  });

  it("reports what went in and what came out", () => {
    const trace = getFixture("opaque-library").build();
    const push = trace.events.find((e) => e.t === "frame_push" && e.kind === "library");
    const pop = trace.events.find((e) => e.t === "frame_pop");
    expect(push?.t === "frame_push" && push.args).toHaveLength(1);
    expect(pop?.t === "frame_pop" && pop.return_value).toEqual(prim('{"a": 1}'));
  });

  it("leaves the argument object inspectable", () => {
    const store = load("opaque-library");
    store.fastForward();
    const data = store.lookup("data");
    expect(data && isRef(data)).toBe(true);
    const target = store.state.objects.get(isRef(data!) ? data.ref : -1);
    expect(target?.slots.get("a")).toEqual(prim(1));
  });
});

describe("rebinding", () => {
  it("carries the previous value on every rebind", () => {
    const trace = getFixture("rebinding").build();
    const sets = trace.events.filter((e) => e.t === "var_set" && e.name === "n");
    expect(sets).toHaveLength(4);
    const [first, ...rest] = sets;
    expect(first?.t === "var_set" && first.prev).toBeUndefined();
    expect(first?.t === "var_set" && first.declared).toBe(true);
    for (const event of rest) {
      expect(event.t === "var_set" && event.prev, "every rebind must record what it overwrote")
        .toBeDefined();
    }
  });

  it("shows the right value at each step when walked backward", () => {
    const store = load("rebinding");
    store.fastForward();
    expect(store.lookup("n")).toEqual(prim(14));
    store.seekChange({ kind: "variable", frame: 0, name: "n" }, -1);
    expect(store.lookup("n")).toEqual(prim(14));
    store.seekChange({ kind: "variable", frame: 0, name: "n" }, -1);
    expect(store.lookup("n")).toEqual(prim(15));
    store.seekChange({ kind: "variable", frame: 0, name: "n" }, -1);
    expect(store.lookup("n")).toEqual(prim(5));
  });
});

describe("branching", () => {
  it("records the condition text and which way control went, without a value", () => {
    const trace = getFixture("branching").build();
    const branches = trace.events.filter((e) => e.t === "branch");
    expect(branches).toHaveLength(2);
    const [first, second] = branches;
    expect(first?.t === "branch" && first.expr).toBe("score >= 90");
    expect(first?.t === "branch" && first.outcome).toBe("not_taken");
    expect(second?.t === "branch" && second.expr).toBe("score >= 70");
    expect(second?.t === "branch" && second.outcome).toBe("taken");
    // Python cannot surface the condition's value without re-evaluating it, so it must be absent.
    for (const branch of branches) {
      expect(branch.t === "branch" && branch.result).toBeUndefined();
    }
  });

  it("takes the elif and assigns B", () => {
    const store = load("branching");
    store.fastForward();
    expect(store.lookup("grade")).toEqual(prim("B"));
  });
});

describe("loop-sum", () => {
  it("counts five iterations and sums to ten", () => {
    const store = load("loop-sum");
    store.fastForward();
    expect(store.lookup("total")).toEqual(prim(10));
    expect(store.state.metrics.get("iteration")).toBe(5);
  });

  it("reports why the loop ended", () => {
    const trace = getFixture("loop-sum").build();
    const exit = trace.events.find((e) => e.t === "loop_exit");
    expect(exit?.t === "loop_exit" && exit.reason).toBe("condition");
    expect(exit?.t === "loop_exit" && exit.iterations).toBe(5);
  });
});

describe("loop-break", () => {
  it("stops at the first value over ten", () => {
    const store = load("loop-break");
    store.fastForward();
    expect(store.lookup("found")).toEqual(prim(15));
  });

  it("attributes the exit to the break, not the condition", () => {
    const trace = getFixture("loop-break").build();
    const exit = trace.events.find((e) => e.t === "loop_exit");
    expect(exit?.t === "loop_exit" && exit.reason).toBe("break");
    expect(exit?.t === "loop_exit" && exit.iterations).toBe(3);
  });
});

describe("function-call", () => {
  it("retains the frame after it returns, with its return value", () => {
    const store = load("function-call");
    store.fastForward();
    const add = [...store.state.frames.values()].find((f) => f.func === "add");
    expect(add, "the returned frame is kept so the timeline can inspect it").toBeDefined();
    expect(add?.active).toBe(false);
    expect(add?.returnValue).toEqual(prim(7));
    expect(add?.bindings.get("result")).toEqual(prim(7));
  });

  it("supports stepping into and out of the call", () => {
    const store = load("function-call");
    expect(store.stepInto()).toBe(true);
    expect(currentFrame(store.state)?.func).toBe("<module>");
    expect(store.stepInto()).toBe(true);
    expect(currentFrame(store.state)?.func).toBe("add");
    expect(store.stepOut()).toBe(true);
    expect(currentFrame(store.state)?.func).toBe("<module>");
  });
});

describe("recursion", () => {
  it("opens a distinct frame per depth and reports the depth", () => {
    const trace = getFixture("recursion").build();
    const pushes = trace.events.filter((e) => e.t === "frame_push" && e.func === "fact");
    expect(pushes).toHaveLength(4);
    const depths = pushes.map((e) => (e.t === "frame_push" ? e.recursion_depth : -1));
    expect(depths).toEqual([0, 1, 2, 3]);
    const ids = new Set(pushes.map((e) => e.frame));
    expect(ids.size, "frame ids are never reused, even across recursion").toBe(4);
  });

  it("reaches a stack four deep and returns 24", () => {
    const store = load("recursion");
    let maxDepth = 0;
    while (store.next()) maxDepth = Math.max(maxDepth, store.state.frameOrder.length);
    expect(maxDepth).toBe(5); // module + four fact frames
    const outer = [...store.state.frames.values()].find(
      (f) => f.func === "fact" && f.recursionDepth === 0,
    );
    expect(outer?.returnValue).toEqual(prim(24));
  });

  it("unwinds correctly when stepped backward", () => {
    const store = load("recursion");
    store.fastForward();
    const atEnd = captureState(store.state);
    store.rewind();
    store.fastForward();
    expect(captureState(store.state)).toEqual(atEnd);
  });
});

describe("aliasing", () => {
  it("points both names at the same object", () => {
    const store = load("aliasing");
    store.fastForward();
    const first = store.lookup("first");
    const second = store.lookup("second");
    expect(first).toBeDefined();
    expect(valueEquals(first, second), "aliases must compare equal by identity").toBe(true);
    expect(first && isRef(first)).toBe(true);
  });

  it("shows one mutation through both names", () => {
    const store = load("aliasing");
    store.fastForward();
    const value = store.lookup("first");
    const id = value && isRef(value) ? value.ref : undefined;
    expect(id).toBeDefined();
    const list = store.state.objects.get(id!);
    expect(list?.order).toEqual(["0", "1", "2", "3"]);
    expect(list?.slots.get("3")).toEqual(prim(4));
  });
});

describe("list-operations", () => {
  it("applies append, insert, delete and clear in order", () => {
    const store = load("list-operations");
    const value = (() => {
      store.fastForward();
      return store.lookup("items");
    })();
    const id = value && isRef(value) ? value.ref : undefined;
    const list = store.state.objects.get(id!);
    expect(list?.order).toEqual([]);
    expect(list?.length).toBe(0);
  });

  it("renumbers positions on insert and restores them on undo", () => {
    const store = load("list-operations");
    const trace = getFixture("list-operations").build();
    const insertIndex = trace.events.findIndex((e) => e.t === "obj_set" && e.op === "insert");
    expect(insertIndex).toBeGreaterThan(0);

    store.seekEvent(insertIndex + 1);
    const objId = [...store.state.objects.keys()][0];
    const afterInsert = [...(store.state.objects.get(objId!)?.slots.values() ?? [])];
    expect(afterInsert).toEqual([prim(10), prim(15), prim(20), prim(30)]);

    store.seekEvent(insertIndex);
    const beforeInsert = [...(store.state.objects.get(objId!)?.slots.values() ?? [])];
    expect(beforeInsert, "undoing an insert must restore the original numbering").toEqual([
      prim(10),
      prim(20),
      prim(30),
    ]);
  });

  it("restores cleared entries when a resize is undone", () => {
    const trace = getFixture("list-operations").build();
    const resize = trace.events.find((e) => e.t === "obj_resize");
    expect(resize?.t === "obj_resize" && resize.cleared, "a shrink must name its casualties")
      .toBeDefined();

    const store = new TraceStore();
    store.load(trace);
    const index = trace.events.indexOf(resize!);
    store.seekEvent(index + 1);
    const objId = [...store.state.objects.keys()][0];
    expect(store.state.objects.get(objId!)?.order).toEqual([]);
    store.seekEvent(index);
    expect(store.state.objects.get(objId!)?.order.length).toBeGreaterThan(0);
  });
});

describe("linked-list", () => {
  it("chains three nodes and infers the shape with evidence", () => {
    const store = load("linked-list");
    store.fastForward();
    const head = store.lookup("head");
    const headId = head && isRef(head) ? head.ref : undefined;
    const first = store.state.objects.get(headId!);
    expect(first?.shape).toBe("linked_list");
    expect(first?.shapeConfidence).toBe("high");
    expect(first?.shapeEvidence?.length, "an inference must be able to explain itself")
      .toBeGreaterThan(0);

    const secondRef = first?.slots.get("next");
    expect(secondRef && isRef(secondRef)).toBe(true);
    const second = store.state.objects.get(isRef(secondRef!) ? secondRef.ref : -1);
    expect(second?.slots.get("value")).toEqual(prim(2));
    const thirdRef = second?.slots.get("next");
    const third = store.state.objects.get(isRef(thirdRef!) ? thirdRef.ref : -1);
    expect(third?.slots.get("value")).toEqual(prim(3));
    expect(third?.slots.get("next")).toEqual(prim(null));
  });
});

describe("bst-insert", () => {
  it("builds a tree with 8 at the root and 3, 10 beneath", () => {
    const store = load("bst-insert");
    store.fastForward();
    const root = store.lookup("root");
    const rootNode = store.state.objects.get(isRef(root!) ? root.ref : -1);
    expect(rootNode?.slots.get("key")).toEqual(prim(8));
    expect(rootNode?.shape).toBe("bst");

    const leftRef = rootNode?.slots.get("left");
    const left = store.state.objects.get(isRef(leftRef!) ? leftRef.ref : -1);
    expect(left?.slots.get("key")).toEqual(prim(3));

    const rightRef = rootNode?.slots.get("right");
    const right = store.state.objects.get(isRef(rightRef!) ? rightRef.ref : -1);
    expect(right?.slots.get("key")).toEqual(prim(10));

    // 1 sorts below 3, so it must land on 3's left.
    const oneRef = left?.slots.get("left");
    const one = store.state.objects.get(isRef(oneRef!) ? oneRef.ref : -1);
    expect(one?.slots.get("key")).toEqual(prim(1));
  });
});

describe("exceptions", () => {
  it("records the raise and the handler that caught it", () => {
    const store = load("exception-caught");
    store.fastForward();
    expect(store.state.exceptions).toHaveLength(1);
    expect(store.state.exceptions[0]?.type).toBe("ZeroDivisionError");
    expect(store.state.exceptions[0]?.caught).toBe(true);
    expect(store.lookup("result")).toEqual(prim(null));
  });

  it("keeps an uncaught failure replayable and reports error status", () => {
    const store = load("exception-uncaught");
    store.fastForward();
    expect(store.state.status).toBe("error");
    expect(store.state.exceptions[0]?.caught).toBe(false);
    // The list built before the crash is still there to inspect.
    const values = store.lookup("values");
    expect(values && isRef(values)).toBe(true);
    store.rewind();
    store.fastForward();
    expect(store.state.status).toBe("error");
  });
});

describe("interactive-input", () => {
  it("pauses on each read and clears the prompt once answered", () => {
    const store = load("interactive-input");
    const trace = getFixture("interactive-input").build();
    const requestIndex = trace.events.findIndex((e) => e.t === "stdin_request");

    store.seekEvent(requestIndex + 1);
    expect(store.state.pendingInput?.prompt).toBe("Name: ");

    store.seekEvent(requestIndex + 2);
    expect(store.state.pendingInput).toBeUndefined();

    // Going back must restore the waiting state, not skip it.
    store.seekEvent(requestIndex + 1);
    expect(store.state.pendingInput?.prompt).toBe("Name: ");
  });

  it("records responses so replay needs no human", () => {
    const trace = getFixture("interactive-input").build();
    const responses = trace.events.filter((e) => e.t === "stdin_response");
    expect(responses).toHaveLength(2);
    expect(responses.every((e) => e.t === "stdin_response" && e.text.length > 0)).toBe(true);

    const store = new TraceStore();
    store.load(trace);
    store.fastForward();
    expect(store.lookup("name")).toEqual(prim("Ada"));
    expect(store.lookup("age")).toEqual(prim(36));
  });
});

describe("collapsed-loop", () => {
  it("folds the middle while reaching the correct total", () => {
    const store = load("collapsed-loop");
    store.fastForward();
    const expected = (999 * 1000) / 2;
    expect(store.lookup("total")).toEqual(prim(expected));
    expect(store.state.metrics.get("iteration")).toBe(1000);
  });

  it("inverts the folded span exactly", () => {
    const trace = getFixture("collapsed-loop").build();
    const index = trace.events.findIndex((e) => e.t === "collapse");
    expect(index).toBeGreaterThan(0);

    const store = new TraceStore();
    store.load(trace);
    store.seekEvent(index);
    const before = captureState(store.state);

    store.seekEvent(index + 1);
    const after = captureState(store.state);
    expect(after, "the fold must actually advance state").not.toEqual(before);

    store.seekEvent(index);
    expect(
      captureState(store.state),
      "stepping back across a fold must restore exactly what preceded it",
    ).toEqual(before);
  });

  it("holds far fewer events than iterations", () => {
    const store = load("collapsed-loop");
    expect(store.eventCount).toBeLessThan(200);
  });

  it("says that it collapsed something", () => {
    const store = load("collapsed-loop");
    store.fastForward();
    expect(store.state.notes.some((n) => n.text.includes("collapsed"))).toBe(true);
  });
});

describe("truncated-run", () => {
  it("reports the limit it hit and stays usable", () => {
    const store = load("truncated-run");
    store.fastForward();
    expect(store.state.status).toBe("step_limit");
    expect(store.state.notes.some((n) => n.level === "warn")).toBe(true);
    expect(store.stepCount).toBeGreaterThan(0);
  });
});

describe("native-pointers", () => {
  it("marks the pointer dangling after the free", () => {
    const store = load("native-pointers");
    store.fastForward();
    const p = store.lookup("p");
    expect(p && "addr" in p).toBe(true);
    expect(p && "dangling" in p && p.dangling).toBe(true);
  });

  it("flags the freed object without discarding it", () => {
    const store = load("native-pointers");
    store.fastForward();
    const cell = [...store.state.objects.values()][0];
    expect(cell?.freed).toBe(true);
    expect(cell?.addr).toBe("0x5f2a10");
    // The value written before the free is still inspectable.
    expect(cell?.slots.get("value")).toEqual(prim(42));
  });

  it("pairs every allocation with its free", () => {
    const trace = getFixture("native-pointers").build();
    const allocs = trace.events.filter((e) => e.t === "mem_alloc");
    const frees = trace.events.filter((e) => e.t === "mem_free");
    expect(allocs).toHaveLength(1);
    expect(frees).toHaveLength(1);
  });
});
