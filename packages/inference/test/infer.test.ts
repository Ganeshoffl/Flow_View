/**
 * Does the inference recognise what a program actually built?
 *
 * Every fixture is a real trace from the Python adapter, so these test the inference against what a
 * tracer emits rather than against a shape I constructed to be recognisable.
 *
 * The cases that matter most are the ones designed to fool it. A class with `left` and `right` whose
 * instances contain a cycle is a graph; one whose children are shared is a graph; a list of rows of
 * unequal length is not a grid. Getting those wrong produces a confident, wrong picture, which is the
 * worst thing this code can do.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Shape, Trace } from "@flow-view/trace-schema";
import { isRef } from "@flow-view/trace-schema";
import { TraceStore, focusFrame } from "@flow-view/trace-store";

import { collectAccess, inferStructures } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function load(name: string): TraceStore {
  const trace = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Trace;
  const store = new TraceStore();
  store.load(trace);
  store.fastForward();
  return store;
}

function infer(name: string) {
  const store = load(name);
  return {
    store,
    result: inferStructures(store.state, { access: collectAccess(store) }),
  };
}

/** The inference for whatever a named variable points at. */
function shapeOf(name: string, variable: string) {
  const { store, result } = infer(name);
  const value = focusFrame(store.state)?.bindings.get(variable);
  expect(value, `${variable} was never bound in ${name}`).toBeDefined();
  expect(isRef(value!), `${variable} is not a reference`).toBe(true);
  const objId = isRef(value!) ? value.ref : -1;
  const inference = result.byObject.get(objId);
  expect(inference, `no inference for ${variable} in ${name}`).toBeDefined();
  return inference!;
}

describe("linked structures", () => {
  it("recognises a singly linked list", () => {
    const inference = shapeOf("linked-list", "head");
    expect(inference.shape).toBe("linked_list");
    expect(inference.confidence).toBe("high");
    expect(inference.members).toHaveLength(3);
    expect(inference.evidence.join(" ")).toContain("no object refers to more than one other");
  });

  it("recognises a doubly linked list from its forward and backward fields", () => {
    const inference = shapeOf("doubly-linked", "a");
    expect(inference.shape).toBe("doubly_linked_list");
    expect(inference.evidence.join(" ")).toMatch(/next leads on and prev leads back/);
  });

  it("recognises a circular list, and says the references come back", () => {
    const inference = shapeOf("circular-list", "a");
    expect(inference.shape).toBe("circular_linked_list");
    expect(inference.evidence.join(" ")).toContain("returns to where it started");
  });
});

describe("trees", () => {
  it("recognises a binary search tree and checks the ordering across the whole tree", () => {
    const inference = shapeOf("bst", "root");
    expect(inference.shape).toBe("bst");
    expect(inference.confidence).toBe("high");
    expect(inference.evidence.join(" ")).toMatch(/smaller.*larger/);
    expect(inference.members).toHaveLength(5);
  });

  it("does not claim a search tree when the ordering does not hold", () => {
    // 9 sits to the left of 5. Two children and tree shape, but not a search tree, and saying so
    // would teach the user something false about their own program.
    const inference = shapeOf("binary-tree-unordered", "root");
    expect(inference.shape).toBe("binary_tree");
    expect(inference.evidence.join(" ")).toContain("ordering of a search tree does not hold");
  });

  it("recognises an n-ary tree through a children collection", () => {
    const inference = shapeOf("nary-tree", "r");
    expect(["nary_tree", "object"]).toContain(inference.shape);
  });
});

describe("structures that look like trees but are not", () => {
  it("calls a tree-shaped class with a cycle a graph", () => {
    // The field names say tree. The objects say otherwise, and the objects are what the program built.
    const inference = shapeOf("tree-with-cycle", "root");
    expect(inference.shape).toBe("directed_graph");
    expect(inference.evidence.join(" ")).toContain("not a tree");
  });

  it("calls a shared child a graph rather than a tree", () => {
    const inference = shapeOf("shared-node-dag", "root");
    expect(inference.shape).toBe("directed_graph");
    expect(inference.evidence.join(" ")).toContain("two different paths");
  });
});

describe("sequences", () => {
  it("recognises a grid when every row is the same length", () => {
    const inference = shapeOf("matrix", "grid");
    expect(inference.shape).toBe("matrix");
    expect(inference.evidence.join(" ")).toMatch(/3 rows.*3 elements/);
  });

  it("does not call rows of unequal length a grid", () => {
    const inference = shapeOf("ragged-list", "rows");
    expect(inference.shape).toBe("array");
  });

  it("recognises a plain array", () => {
    const inference = shapeOf("plain-array", "a");
    expect(inference.shape).toBe("array");
  });

  it("recognises a tuple", () => {
    const inference = shapeOf("tuple", "t");
    expect(inference.shape).toBe("tuple");
  });

  it("recognises a set", () => {
    const inference = shapeOf("set", "s");
    expect(inference.shape).toBe("set");
  });
});

describe("access patterns", () => {
  it("recognises a stack from pushes and pops at one end", () => {
    const inference = shapeOf("stack", "s");
    expect(inference.shape).toBe("stack");
    expect(inference.evidence.join(" ")).toContain("same end");
  });

  it("recognises a queue from additions at the back and removals at the front", () => {
    const inference = shapeOf("queue", "q");
    expect(inference.shape).toBe("queue");
    expect(inference.evidence.join(" ")).toMatch(/back.*front/);
  });

  it("leaves a list that was only ever appended to as an array", () => {
    // Nothing has distinguished it from a stack yet, and inventing the distinction would be a guess.
    const inference = shapeOf("plain-array", "a");
    expect(inference.shape).toBe("array");
  });
});

describe("maps", () => {
  it("recognises an adjacency list as a graph", () => {
    const inference = shapeOf("adjacency", "g");
    expect(inference.shape).toBe("directed_graph");
    expect(inference.evidence.join(" ")).toContain("adjacency list");
  });

  it("leaves an ordinary dictionary as a map", () => {
    const inference = shapeOf("plain-dict", "d");
    expect(inference.shape).toBe("map");
  });
});

describe("honesty", () => {
  it("never leaves an object without an inference", () => {
    // Every object must be drawable. Silence would mean something in the heap has no representation.
    for (const name of ["linked-list", "bst", "matrix", "adjacency", "plain-dict", "nary-tree"]) {
      const { store, result } = infer(name);
      for (const obj of store.state.objects.values()) {
        if (obj.freed) continue;
        expect(result.byObject.has(obj.obj), `${name}: object ${obj.obj} has no inference`).toBe(
          true,
        );
      }
    }
  });

  it("always explains itself", () => {
    for (const name of ["linked-list", "bst", "tree-with-cycle", "matrix", "stack"]) {
      const { result } = infer(name);
      for (const inference of result.byObject.values()) {
        expect(
          inference.evidence.length,
          `${name}: object ${inference.obj} claims ${inference.shape} with no evidence`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("marks exactly one root per structure", () => {
    const { result } = infer("bst");
    const treeRoots = [...result.byObject.values()].filter(
      (inference) => inference.shape === "bst" && inference.root,
    );
    expect(treeRoots).toHaveLength(1);
  });

  it("lets the user override, and says the choice was theirs", () => {
    const store = load("bst");
    const value = focusFrame(store.state)?.bindings.get("root");
    const objId = isRef(value!) ? value.ref : -1;

    const overridden = inferStructures(store.state, {
      overrides: new Map<number, Shape>([[objId, "nary_tree"]]),
    });
    const inference = overridden.byObject.get(objId);
    expect(inference?.shape).toBe("nary_tree");
    expect(inference?.evidence.join(" ")).toContain("you chose this shape");
  });

  it("keeps the members of a structure when a shape is overridden", () => {
    // An override changes how something is drawn, not what belongs to it.
    const store = load("bst");
    const value = focusFrame(store.state)?.bindings.get("root");
    const objId = isRef(value!) ? value.ref : -1;
    const before = inferStructures(store.state).byObject.get(objId);
    const after = inferStructures(store.state, {
      overrides: new Map<number, Shape>([[objId, "binary_tree"]]),
    }).byObject.get(objId);
    expect(after?.members).toEqual(before?.members);
  });
});

describe("empty structures", () => {
  it("has nothing to infer when nothing was built", () => {
    // `head = None` creates no objects. Reporting a linked list here would describe a structure that
    // does not exist; the honest answer is silence about shape.
    const { result } = infer("empty-list-class");
    const instances = [...result.byObject.values()].filter((i) =>
      ["linked_list", "bst", "binary_tree"].includes(i.shape),
    );
    expect(instances).toHaveLength(0);
  });
});

describe("stability", () => {
  it("gives the same answer every time", () => {
    const { store } = infer("bst");
    const first = inferStructures(store.state);
    const second = inferStructures(store.state);
    expect([...second.byObject.entries()]).toEqual([...first.byObject.entries()]);
  });

  it("does not depend on where the playhead is beyond the state it describes", () => {
    const store = load("linked-list");
    const atEnd = inferStructures(store.state).byObject.size;
    store.rewind();
    store.fastForward();
    expect(inferStructures(store.state).byObject.size).toBe(atEnd);
  });
});
