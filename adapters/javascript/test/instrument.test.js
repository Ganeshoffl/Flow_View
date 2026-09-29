/**
 * What the instrumenter must never get wrong.
 *
 * The conformance corpus checks these properties end to end, by running programs. These check them at the
 * level where they are decided, which is where a regression is legible: "the scan after the block mentions
 * y" is a sentence you can act on, where "case 017 failed" needs an investigation first.
 */

import { describe, expect, it } from "vitest";

import { instrument } from "../src/instrument.js";

/** The instrumented text, split into lines. */
function lines(source) {
  return instrument(source, { path: "main.js" }).code.split("\n");
}

describe("line numbers", () => {
  it("does not move any line", () => {
    // Everything downstream reads `line` as a position in the user's own source. If instrumentation
    // inserted a newline anywhere, every line after it would be reported one too high and the code pane
    // would highlight the wrong statement.
    const source = ["let a = 1;", "let b = 2;", "", "function f(x) {", "  return x + 1;", "}", "f(a);"].join(
      "\n",
    );
    expect(lines(source)).toHaveLength(source.split("\n").length);
  });

  it("marks each statement with the line it is actually on", () => {
    const source = ["let a = 1;", "let b = 2;", "let c = 3;"].join("\n");
    const out = lines(source);
    expect(out[0]).toContain("line(1)");
    expect(out[1]).toContain("line(2)");
    expect(out[2]).toContain("line(3)");
  });
});

describe("scope", () => {
  it("does not mention a block-scoped name after its block has ended", () => {
    // Naming an out-of-scope variable in generated code does not produce a slightly wrong trace: it throws
    // a ReferenceError and kills the program being watched.
    const source = ["let x = 1;", "if (x > 0) {", "  let y = 2;", "  x = x + y;", "}", "x = 5;"].join("\n");
    const out = lines(source);

    expect(out[2]).toContain('"y":y');
    // The scan closing the `if` sits on the line the `if` started on.
    expect(out[4]).not.toContain('"y":y');
    expect(out[5]).not.toContain('"y":y');
  });

  it("keeps a var declared inside a block visible after it", () => {
    // `var` really is function-scoped. Treating it like `let` would drop it from the trace while the program
    // could still see it.
    const source = ["let a = 1;", "if (a) {", "  var kept = 2;", "}", "a = 3;"].join("\n");
    const out = lines(source);
    expect(out[4]).toContain('"kept":kept');
  });

  it("puts a loop counter in scope inside the body", () => {
    const source = ["let total = 0;", "for (let i = 0; i < 3; i++) {", "  total += i;", "}"].join("\n");
    const out = lines(source);
    expect(out[2]).toContain('"i":i');
    // ...and not after the loop, where `let i` no longer exists.
    expect(out[3]).not.toContain('"i":i');
  });

  it("puts a for-of binding in scope inside the body", () => {
    const source = ["let n = 0;", "for (const item of [1, 2]) {", "  n += item;", "}"].join("\n");
    expect(lines(source)[2]).toContain('"item":item');
  });

  it("puts a caught error in scope inside the handler", () => {
    const source = ["try {", "  go();", "} catch (err) {", "  report(err);", "}"].join("\n");
    const out = lines(source);
    expect(out[3]).toContain('"err":err');
    expect(out[0]).not.toContain('"err":err');
  });

  it("does not report an enclosing function's variables as locals of an inner one", () => {
    const source = ["function outer() {", "  let a = 1;", "  function inner() {", "    let b = 2;", "    return b;", "  }", "  return inner();", "}"].join("\n");
    const out = lines(source);
    // `b` is inner's own; `a` belongs to outer and is reachable only through a closure.
    expect(out[3]).toContain('"b":b');
    expect(out[3]).not.toContain('"a":a');
  });
});

describe("branches", () => {
  it("reports a chained else-if as elif, and a plain if as if", () => {
    const source = ["if (a) {", "  x();", "} else if (b) {", "  y();", "}"].join("\n");
    const code = instrument(source, { path: "main.js" }).code;
    expect(code).toContain('branch(1,"if"');
    expect(code).toContain('branch(3,"elif"');
  });

  it("hands the condition's outcome over rather than the condition itself", () => {
    // Re-evaluating a condition to find out how it went would run its side effects twice.
    const code = instrument("if (xs.pop()) { go(); }", { path: "main.js" }).code;
    expect(code).toContain('branch(1,"if","xs.pop()",xs.pop())');
    expect(code.match(/xs\.pop\(\)/g)).toHaveLength(2); // once as text, once as the value
  });
});

describe("jumps", () => {
  it("announces a break before it happens", () => {
    // The loop only learns why it ended afterwards, so the jump has to be recorded as control leaves.
    const source = ["while (true) {", "  break;", "}"].join("\n");
    expect(lines(source)[1]).toContain('jump(2,"break")');
  });

  it("announces a continue", () => {
    const source = ["for (const x of xs) {", "  continue;", "}"].join("\n");
    expect(lines(source)[1]).toContain('jump(2,"continue")');
  });
});

describe("parse failures", () => {
  it("reports the problem rather than crashing", () => {
    expect(() => instrument("let = ;", { path: "main.js" })).toThrow();
  });
});
