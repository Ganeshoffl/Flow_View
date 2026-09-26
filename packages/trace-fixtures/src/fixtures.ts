/**
 * The fixture corpus.
 *
 * These traces are the reference for what an adapter must produce. Each one isolates a construct —
 * assignment, branching, recursion, aliasing, a linked list, an uncaught exception — so that a
 * renderer can be built and a store verified before any real language is wired up.
 *
 * In Phase 1 the same programs become the conformance corpus: every adapter runs them for real and
 * its output is checked against the expectations encoded here. A fixture that lies about what
 * Python does is therefore a bug that Phase 1 catches, which is the point of ordering the work this
 * way rather than trusting the fixtures forever.
 */

import { type Language, type Trace, prim, ref } from "@flow-view/trace-schema";

import { TraceBuilder } from "./builder.js";

export interface Fixture {
  readonly id: string;
  readonly title: string;
  /** What this fixture is for, shown in the UI picker. */
  readonly summary: string;
  readonly language: Language;
  readonly source: readonly string[];
  /** Concepts exercised, so the picker can group them. */
  readonly concepts: readonly string[];
  /** Built fresh on each call: traces are never shared mutable state. */
  readonly build: () => Trace;
}

// ---------------------------------------------------------------------------

const assignment: Fixture = {
  id: "assignment",
  title: "Assignment and output",
  summary: "The smallest useful trace: three lines, two variables, one opaque library call.",
  language: "python",
  concepts: ["variables", "library calls", "stdout"],
  source: ["x = 1", "y = x + 2", "print(y)"],
  build: () => {
    const b = new TraceBuilder({ id: "assignment", source: assignment.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1).setPrim("x", 1);
    b.line(2).setPrim("y", 3);
    b.line(3).libraryCall("print", [prim(3)], prim(null));
    b.out("3\n");
    return b.build();
  },
};

const rebinding: Fixture = {
  id: "rebinding",
  title: "Rebinding a variable",
  summary:
    "The same name taking four values in turn. Every step carries what it overwrote, which is what " +
    "makes backward stepping possible.",
  language: "python",
  concepts: ["variables", "invertibility"],
  source: ["n = 0", "n = n + 5", "n = n * 3", "n = n - 1", "print(n)"],
  build: () => {
    const b = new TraceBuilder({ id: "rebinding", source: rebinding.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1).setPrim("n", 0);
    b.line(2).setPrim("n", 5);
    b.line(3).setPrim("n", 15);
    b.line(4).setPrim("n", 14);
    b.line(5).libraryCall("print", [prim(14)], prim(null));
    b.out("14\n");
    return b.build();
  },
};

const branching: Fixture = {
  id: "branching",
  title: "Branching",
  summary:
    "An if/elif/else chain. Each decision records the condition text and which way control went, " +
    "never the condition's value — evaluating it again could fire side effects.",
  language: "python",
  concepts: ["control flow", "branches"],
  source: [
    "score = 72",
    "if score >= 90:",
    "    grade = 'A'",
    "elif score >= 70:",
    "    grade = 'B'",
    "else:",
    "    grade = 'C'",
    "print(grade)",
  ],
  build: () => {
    const b = new TraceBuilder({ id: "branching", source: branching.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1).setPrim("score", 72);
    b.line(2).branch("if", "score >= 90", "not_taken", { line: 2, targetLine: 4 });
    b.metric("comparison", 1);
    b.line(4).branch("elif", "score >= 70", "taken", { line: 4, targetLine: 5 });
    b.metric("comparison", 1);
    b.line(5).setPrim("grade", "B");
    b.line(8).libraryCall("print", [prim("B")], prim(null));
    b.out("B\n");
    return b.build();
  },
};

const loopSum: Fixture = {
  id: "loop-sum",
  title: "Loop with an accumulator",
  summary: "A for loop over five values, with iteration boundaries and running metrics.",
  language: "python",
  concepts: ["loops", "metrics"],
  source: ["total = 0", "for i in range(5):", "    total += i", "print(total)"],
  build: () => {
    const b = new TraceBuilder({ id: "loop-sum", source: loopSum.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1).setPrim("total", 0);
    const region = b.loopEnter(2, 3);
    let total = 0;
    for (let i = 0; i < 5; i++) {
      b.loopIter(region, i);
      b.line(2).branch("for", "i in range(5)", "taken", { line: 2, targetLine: 3 });
      b.setPrim("i", i);
      total += i;
      b.line(3).setPrim("total", total);
    }
    b.line(2).branch("for", "i in range(5)", "not_taken", { line: 2, targetLine: 4 });
    b.loopExit(region, 5);
    b.line(4).libraryCall("print", [prim(total)], prim(null));
    b.out(`${total}\n`);
    return b.build();
  },
};

const loopBreak: Fixture = {
  id: "loop-break",
  title: "Loop with break",
  summary: "A search that stops early, so the loop reports why it ended rather than just that it did.",
  language: "python",
  concepts: ["loops", "break", "control flow"],
  source: [
    "values = [4, 8, 15, 16, 23]",
    "found = -1",
    "for i in range(len(values)):",
    "    if values[i] > 10:",
    "        found = values[i]",
    "        break",
    "print(found)",
  ],
  build: () => {
    const b = new TraceBuilder({ id: "loop-break", source: loopBreak.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1);
    const list = b.list([prim(4), prim(8), prim(15), prim(16), prim(23)]);
    b.hint(list, "array", "high", ["five integer elements in positional order"], true);
    b.set("values", ref(list));
    b.line(2).setPrim("found", -1);
    const region = b.loopEnter(3, 6);
    const data = [4, 8, 15, 16, 23];
    for (let i = 0; i < data.length; i++) {
      const value = data[i] ?? 0;
      b.loopIter(region, i);
      b.line(3).setPrim("i", i);
      b.metric("read", 1);
      const hit = value > 10;
      b.line(4).branch("if", "values[i] > 10", hit ? "taken" : "not_taken", {
        line: 4,
        targetLine: hit ? 5 : 3,
      });
      b.metric("comparison", 1);
      if (hit) {
        b.line(5).setPrim("found", value);
        b.line(6).jump("break", 7);
        b.loopExit(region, i + 1, "break");
        break;
      }
    }
    b.line(7).libraryCall("print", [prim(15)], prim(null));
    b.out("15\n");
    return b.build();
  },
};

const functionCall: Fixture = {
  id: "function-call",
  title: "Calling a function",
  summary: "Arguments in, a return value out, and a frame that is retained after it returns.",
  language: "python",
  concepts: ["functions", "frames", "return values"],
  source: [
    "def add(a, b):",
    "    result = a + b",
    "    return result",
    "",
    "total = add(3, 4)",
    "print(total)",
  ],
  build: () => {
    const b = new TraceBuilder({ id: "function-call", source: functionCall.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1);
    b.line(5);
    b.push("add", [{ name: "a", value: prim(3) }, { name: "b", value: prim(4) }], { line: 1 });
    b.line(2).setPrim("result", 7);
    b.line(3);
    b.pop(prim(7));
    b.set("total", prim(7));
    b.line(6).libraryCall("print", [prim(7)], prim(null));
    b.out("7\n");
    return b.build();
  },
};

const recursion: Fixture = {
  id: "recursion",
  title: "Recursion",
  summary:
    "factorial(4): four nested frames, each with its own n, unwinding one at a time. Stepping " +
    "backward through the unwind is the clearest demonstration of replayed history.",
  language: "python",
  concepts: ["recursion", "frames", "call stack"],
  source: [
    "def fact(n):",
    "    if n <= 1:",
    "        return 1",
    "    return n * fact(n - 1)",
    "",
    "print(fact(4))",
  ],
  build: () => {
    const b = new TraceBuilder({ id: "recursion", source: recursion.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1);
    b.line(6);

    const descend = (n: number): number => {
      b.push("fact", [{ name: "n", value: prim(n) }], { line: 1 });
      const base = n <= 1;
      b.line(2).branch("if", "n <= 1", base ? "taken" : "not_taken", {
        line: 2,
        targetLine: base ? 3 : 4,
      });
      b.metric("comparison", 1);
      if (base) {
        b.line(3);
        b.pop(prim(1));
        return 1;
      }
      b.line(4);
      const inner = descend(n - 1);
      const result = n * inner;
      b.pop(prim(result));
      return result;
    };

    const result = descend(4);
    b.libraryCall("print", [prim(result)], prim(null));
    b.out(`${result}\n`);
    return b.build();
  },
};

const aliasing: Fixture = {
  id: "aliasing",
  title: "Aliasing",
  summary:
    "Two names for one list. The mutation happens once and is visible through both, which is only " +
    "representable because values hold references rather than nested copies.",
  language: "python",
  concepts: ["references", "aliasing", "mutation"],
  source: [
    "first = [1, 2, 3]",
    "second = first",
    "second.append(4)",
    "print(first)",
    "print(len(first) == len(second))",
  ],
  build: () => {
    const b = new TraceBuilder({ id: "aliasing", source: aliasing.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1);
    const list = b.list([prim(1), prim(2), prim(3)]);
    b.hint(list, "array", "high", ["three integer elements in positional order"], true);
    b.set("first", ref(list));
    b.line(2).set("second", ref(list));
    b.line(3);
    b.push("append", [{ name: "arg0", value: prim(4) }], { kind: "library", line: 3 });
    b.objAppend(list, prim(4));
    b.pop(prim(null));
    b.line(4).libraryCall("print", [ref(list)], prim(null));
    b.out("[1, 2, 3, 4]\n");
    b.line(5).libraryCall("print", [prim(true)], prim(null));
    b.out("True\n");
    return b.build();
  },
};

const listOperations: Fixture = {
  id: "list-operations",
  title: "List operations",
  summary:
    "Append, insert, delete and clear. Insert and delete renumber positions, and each records " +
    "enough to be undone exactly.",
  language: "python",
  concepts: ["arrays", "mutation", "invertibility"],
  source: [
    "items = [10, 20]",
    "items.append(30)",
    "items.insert(1, 15)",
    "del items[0]",
    "items.clear()",
  ],
  build: () => {
    const b = new TraceBuilder({ id: "list-operations", source: listOperations.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1);
    const list = b.list([prim(10), prim(20)]);
    b.hint(list, "array", "high", ["positional integer elements"], true);
    b.set("items", ref(list));
    b.line(2).objAppend(list, prim(30));
    b.line(3).objInsert(list, 1, prim(15));
    b.line(4).objDelete(list, 0);
    b.line(5).objResize(list, 0);
    return b.build();
  },
};

const linkedList: Fixture = {
  id: "linked-list",
  title: "Linked list",
  summary:
    "Three nodes chained by a next field. The shape is inferred from the object graph and carries " +
    "the evidence behind the guess.",
  language: "python",
  concepts: ["linked list", "structure inference", "references"],
  source: [
    "class Node:",
    "    def __init__(self, value):",
    "        self.value = value",
    "        self.next = None",
    "",
    "head = Node(1)",
    "head.next = Node(2)",
    "head.next.next = Node(3)",
  ],
  build: () => {
    const b = new TraceBuilder({ id: "linked-list", source: linkedList.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1);

    const makeNode = (value: number, line: number): number => {
      b.line(line);
      b.push("Node", [{ name: "value", value: prim(value) }], { kind: "constructor", line: 2 });
      const obj = b.newObj("instance", "Node", { summary: `Node(value=${value})` });
      b.line(3).objSet(obj, "value", prim(value));
      b.line(4).objSet(obj, "next", prim(null));
      b.pop(ref(obj));
      return obj;
    };

    const first = makeNode(1, 6);
    b.set("head", ref(first));
    b.hint(first, "linked_list", "high", [
      "Node.next refers to another Node",
      "each node has exactly one outgoing self-type reference",
      "no cycle reachable from head",
    ], true);

    const second = makeNode(2, 7);
    b.objSet(first, "next", ref(second));

    const third = makeNode(3, 8);
    b.objSet(second, "next", ref(third));
    return b.build();
  },
};

const bstInsert: Fixture = {
  id: "bst-insert",
  title: "Binary search tree",
  summary:
    "Four inserts into a BST. Ordering invariants hold across the whole tree, which is what " +
    "separates a bst hint from a plain binary_tree.",
  language: "python",
  concepts: ["binary tree", "bst", "structure inference", "recursion"],
  source: [
    "class Node:",
    "    def __init__(self, key):",
    "        self.key = key",
    "        self.left = None",
    "        self.right = None",
    "",
    "def insert(node, key):",
    "    if node is None:",
    "        return Node(key)",
    "    if key < node.key:",
    "        node.left = insert(node.left, key)",
    "    else:",
    "        node.right = insert(node.right, key)",
    "    return node",
    "",
    "root = None",
    "for key in [8, 3, 10, 1]:",
    "    root = insert(root, key)",
  ],
  build: () => {
    const b = new TraceBuilder({ id: "bst-insert", source: bstInsert.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1);
    b.line(16).setPrim("root", null);

    interface Node {
      readonly obj: number;
      readonly key: number;
      left: Node | null;
      right: Node | null;
    }

    const newNode = (key: number): Node => {
      b.push("Node", [{ name: "key", value: prim(key) }], { kind: "constructor", line: 2 });
      const obj = b.newObj("instance", "Node", { summary: `Node(key=${key})` });
      b.line(3).objSet(obj, "key", prim(key));
      b.line(4).objSet(obj, "left", prim(null));
      b.line(5).objSet(obj, "right", prim(null));
      b.pop(ref(obj));
      return { obj, key, left: null, right: null };
    };

    const insert = (current: Node | null, key: number): Node => {
      b.push(
        "insert",
        [
          { name: "node", value: current === null ? prim(null) : ref(current.obj) },
          { name: "key", value: prim(key) },
        ],
        { line: 7 },
      );
      if (current === null) {
        b.line(8).branch("if", "node is None", "taken", { line: 8, targetLine: 9 });
        b.line(9);
        const created = newNode(key);
        b.pop(ref(created.obj));
        return created;
      }
      b.line(8).branch("if", "node is None", "not_taken", { line: 8, targetLine: 10 });
      const goLeft = key < current.key;
      b.metric("comparison", 1);
      b.line(10).branch("if", "key < node.key", goLeft ? "taken" : "not_taken", {
        line: 10,
        targetLine: goLeft ? 11 : 13,
      });
      if (goLeft) {
        b.line(11);
        current.left = insert(current.left, key);
        b.objSet(current.obj, "left", ref(current.left.obj));
      } else {
        b.line(13);
        current.right = insert(current.right, key);
        b.objSet(current.obj, "right", ref(current.right.obj));
      }
      b.line(14);
      b.pop(ref(current.obj));
      return current;
    };

    const region = b.loopEnter(17, 18);
    let root: Node | null = null;
    const keys = [8, 3, 10, 1];
    keys.forEach((key, i) => {
      b.loopIter(region, i);
      b.line(17).setPrim("key", key);
      b.line(18);
      root = insert(root, key);
      b.set("root", ref(root.obj));
    });
    b.loopExit(region, keys.length);

    const finalRoot = root as Node | null;
    if (finalRoot) {
      b.hint(
        finalRoot.obj,
        "bst",
        "high",
        [
          "Node.left and Node.right both refer to Node",
          "no node is reachable by two paths, so it is a tree rather than a graph",
          "every left descendant is smaller and every right descendant larger",
        ],
        true,
      );
    }
    return b.build();
  },
};

const exceptionCaught: Fixture = {
  id: "exception-caught",
  title: "Exception caught",
  summary: "A raise met by a handler, so execution continues and the trace records both moments.",
  language: "python",
  concepts: ["exceptions", "control flow"],
  source: [
    "def divide(a, b):",
    "    return a / b",
    "",
    "try:",
    "    result = divide(1, 0)",
    "except ZeroDivisionError:",
    "    result = None",
    "print(result)",
  ],
  build: () => {
    const b = new TraceBuilder({ id: "exception-caught", source: exceptionCaught.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1);
    b.line(4);
    b.line(5);
    b.push("divide", [{ name: "a", value: prim(1) }, { name: "b", value: prim(0) }], { line: 1 });
    b.line(2).raise("ZeroDivisionError", "division by zero");
    b.pop(undefined, "exception");
    b.catchAt(6);
    b.line(7).setPrim("result", null);
    b.line(8).libraryCall("print", [prim(null)], prim(null));
    b.out("None\n");
    return b.build();
  },
};

const exceptionUncaught: Fixture = {
  id: "exception-uncaught",
  title: "Exception uncaught",
  summary:
    "A program that dies. The trace keeps everything up to the failure and stays fully " +
    "replayable — a crash is a result to inspect, not a reason to discard the run.",
  language: "python",
  concepts: ["exceptions", "truncation"],
  source: ["values = [1, 2, 3]", "print(values[7])"],
  build: () => {
    const b = new TraceBuilder({ id: "exception-uncaught", source: exceptionUncaught.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1);
    const list = b.list([prim(1), prim(2), prim(3)]);
    b.hint(list, "array", "high", ["positional integer elements"], true);
    b.set("values", ref(list));
    b.line(2).raise("IndexError", "list index out of range");
    b.uncaught("IndexError", "list index out of range", [
      { func: "<module>", path: "main.py", line: 2 },
    ]);
    b.err("Traceback (most recent call last):\n");
    b.err('  File "main.py", line 2, in <module>\n');
    b.err("IndexError: list index out of range\n");
    b.pop(undefined, "exception");
    b.runEnd("error", 1);
    return b.build();
  },
};

const interactiveInput: Fixture = {
  id: "interactive-input",
  title: "Interactive input",
  summary:
    "Two blocking reads. The response is recorded beside the request, so a replay is deterministic " +
    "with no human present.",
  language: "python",
  concepts: ["stdin", "determinism"],
  source: [
    "name = input('Name: ')",
    "age = int(input('Age: '))",
    "print(f'{name} is {age}')",
  ],
  build: () => {
    const b = new TraceBuilder({ id: "interactive-input", source: interactiveInput.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1).input("Name: ", "Ada");
    b.set("name", prim("Ada"));
    b.line(2).input("Age: ", "36");
    b.libraryCall("int", [prim("36")], prim(36));
    b.set("age", prim(36));
    b.line(3).libraryCall("print", [prim("Ada is 36")], prim(null));
    b.out("Ada is 36\n");
    return b.build();
  },
};

const collapsedLoop: Fixture = {
  id: "collapsed-loop",
  title: "Collapsed loop",
  summary:
    "A thousand iterations with the middle folded into one composite step that carries net " +
    "before/after state, so stepping backward across the fold is still exact.",
  language: "python",
  concepts: ["loops", "collapsing", "large traces"],
  source: ["total = 0", "for i in range(1000):", "    total += i", "print(total)"],
  build: () => {
    const b = new TraceBuilder({ id: "collapsed-loop", source: collapsedLoop.source });
    b.runStart();
    const moduleFrame = b.push("<module>", [], { line: 1 });
    b.line(1).setPrim("total", 0);
    const region = b.loopEnter(2, 3);

    let total = 0;
    const detail = (i: number): void => {
      b.loopIter(region, i);
      b.line(2).setPrim("i", i);
      total += i;
      b.line(3).setPrim("total", total);
    };

    // First three iterations in full.
    for (let i = 0; i < 3; i++) detail(i);

    // Iterations 3..996 folded. The composite step carries where each slot started and ended.
    const foldStart = { i: 2, total };
    let folded = total;
    for (let i = 3; i < 997; i++) folded += i;
    b.collapse(region, {
      iterations: 994,
      effects: [
        {
          kind: "var",
          frame: moduleFrame,
          key: "i",
          before: prim(foldStart.i),
          after: prim(996),
        },
        {
          kind: "var",
          frame: moduleFrame,
          key: "total",
          before: prim(foldStart.total),
          after: prim(folded),
        },
      ],
      metrics: { iteration: 994, assignment: 1988 },
    });
    total = folded;

    // Last three iterations in full.
    for (let i = 997; i < 1000; i++) detail(i);

    b.line(2).branch("for", "i in range(1000)", "not_taken", { line: 2, targetLine: 4 });
    b.loopExit(region, 1000);
    b.line(4).libraryCall("print", [prim(total)], prim(null));
    b.out(`${total}\n`);
    b.note("info", "994 of 1000 iterations were collapsed. Expand the region to see them.");
    return b.build();
  },
};

const truncatedRun: Fixture = {
  id: "truncated-run",
  title: "Step budget reached",
  summary:
    "An infinite loop stopped by the step budget. The partial trace is a usable result, and it says " +
    "plainly where it stopped.",
  language: "python",
  concepts: ["limits", "truncation", "honesty"],
  source: ["n = 0", "while True:", "    n += 1"],
  build: () => {
    const b = new TraceBuilder({ id: "truncated-run", source: truncatedRun.source });
    b.runStart();
    b.push("<module>", [], { line: 1 });
    b.line(1).setPrim("n", 0);
    const region = b.loopEnter(2, 3);
    for (let i = 0; i < 6; i++) {
      b.loopIter(region, i);
      b.line(2).branch("while", "True", "taken", { line: 2, targetLine: 3 });
      b.line(3).setPrim("n", i + 1);
    }
    b.note("warn", "Step budget of 200000 steps reached. Execution stopped here.");
    b.pop(undefined, "implicit");
    b.runEnd("step_limit", 0);
    return b.build();
  },
};

const nativePointers: Fixture = {
  id: "native-pointers",
  title: "Dangling pointer",
  summary:
    "C memory: a pointer left aimed at freed storage. The broken arrow is the thing a beginner " +
    "cannot see in their own source.",
  language: "c",
  concepts: ["pointers", "memory", "use after free"],
  source: [
    "#include <stdlib.h>",
    "",
    "int main(void) {",
    "    int *p = malloc(sizeof(int));",
    "    *p = 42;",
    "    free(p);",
    "    return *p;",
    "}",
  ],
  build: () => {
    const b = new TraceBuilder({
      id: "native-pointers",
      language: "c",
      languageVersion: "gcc 11.5.0",
      source: nativePointers.source,
    });
    b.runStart();
    b.push("main", [], { line: 3 });
    b.line(4);
    b.memAlloc("0x5f2a10", 4, "heap", "malloc");
    const cell = b.newObj("struct", "int", { addr: "0x5f2a10", size: 4 });
    b.pointerSet("p", "0x5f2a10", { valid: true, dangling: false });
    b.set("p", b.addrValue("0x5f2a10", "int*"));
    b.line(5).objSet(cell, "value", prim(42));
    b.line(6);
    b.memFree("0x5f2a10", "free");
    b.objFree(cell);
    b.pointerSet("p", "0x5f2a10", { valid: false, dangling: true, prevAddr: "0x5f2a10" });
    b.set("p", b.addrValue("0x5f2a10", "int*", true));
    b.note("warn", "p now points at freed memory. Reading through it is undefined behaviour.");
    b.line(7);
    return b.build();
  },
};

// ---------------------------------------------------------------------------

export const FIXTURES: readonly Fixture[] = [
  assignment,
  rebinding,
  branching,
  loopSum,
  loopBreak,
  functionCall,
  recursion,
  aliasing,
  listOperations,
  linkedList,
  bstInsert,
  exceptionCaught,
  exceptionUncaught,
  interactiveInput,
  collapsedLoop,
  truncatedRun,
  nativePointers,
];

export const FIXTURES_BY_ID: ReadonlyMap<string, Fixture> = new Map(
  FIXTURES.map((fixture) => [fixture.id, fixture]),
);

export function getFixture(id: string): Fixture {
  const fixture = FIXTURES_BY_ID.get(id);
  if (!fixture) {
    const known = FIXTURES.map((f) => f.id).join(", ");
    throw new Error(`No fixture named "${id}". Known fixtures: ${known}`);
  }
  return fixture;
}
