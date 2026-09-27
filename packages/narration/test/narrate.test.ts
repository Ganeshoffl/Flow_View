/**
 * Does the narration say true things, in English?
 *
 * Every fixture is a real trace, so these check what the tracer actually emits rather than events
 * shaped to be easy to describe.
 *
 * Two kinds of assertion. The specific ones check that a construct produces the right sentence — a
 * swap reads as a swap, a recursive call says how deep it is, a caught error says the program carries
 * on. The general ones hold over every sentence of every fixture: no placeholder text, no leaked
 * event names, nothing asserting a condition's value, and a full stop at the end.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Trace, Value } from "@flow-view/trace-schema";
import { formatValue } from "@flow-view/renderers";
import { TraceStore, type TraceState } from "@flow-view/trace-store";

import { narrateCurrent, narrateHistory } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const options = {
  language: "python" as const,
  format: (value: Value | undefined, state: TraceState) =>
    formatValue(value, { language: "python", state }),
};

function load(name: string): TraceStore {
  const trace = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Trace;
  const store = new TraceStore();
  store.load(trace);
  return store;
}

/** Every sentence produced while walking a trace from start to finish. */
function transcript(name: string): string[] {
  const store = load(name);
  const lines: string[] = [];
  while (store.next()) {
    const narrated = narrateCurrent(store, options);
    for (const sentence of narrated?.sentences ?? []) lines.push(sentence.text);
  }
  return lines;
}

const NAMES = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.replace(/\.json$/, ""))
  .sort();

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

describe("a bubble sort narrates itself", () => {
  const lines = transcript("bubble-sort");

  it("says something at almost every step", () => {
    expect(lines.length).toBeGreaterThan(20);
  });

  it("describes a swap as a swap", () => {
    // The whole point of recognising the pattern: two writes that exchange values are one idea, and
    // describing them separately would hide the thing a sorting algorithm is made of.
    const swaps = lines.filter((line) => /are swapped/.test(line));
    expect(swaps.length).toBeGreaterThanOrEqual(3);
    expect(swaps[0]).toMatch(/Positions \d+ and \d+ of `values` are swapped\./);
  });

  it("explains each comparison and which way it went", () => {
    const decisions = lines.filter((line) => line.includes("values[j] > values[j + 1]"));
    expect(decisions.length).toBeGreaterThan(4);
    expect(decisions.some((line) => line.endsWith("so the body runs."))).toBe(true);
    expect(decisions.some((line) => line.endsWith("so the body is skipped."))).toBe(true);
  });

  it("uses the user's own name for the list", () => {
    expect(lines.some((line) => line.includes("`values`"))).toBe(true);
  });

  it("reports the printed result", () => {
    expect(lines.some((line) => /prints `\[1, 2, 4, 5\]`/.test(line))).toBe(true);
  });

  it("says the loops ended and how many times they ran", () => {
    expect(lines.some((line) => /The loop ran \d+ times and ended because/.test(line))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// constructs
// ---------------------------------------------------------------------------

describe("recursion", () => {
  const lines = transcript("recursion");

  it("says a function is calling itself, and how deep it is", () => {
    const recursive = lines.filter((line) => line.includes("calls itself"));
    expect(recursive.length).toBe(3);
    expect(recursive[0]).toMatch(/`fact` calls itself with `n` = 3\. This is second time in, 1 still waiting to finish\./);
  });

  it("reports each return value", () => {
    const returns = lines.filter((line) => /The call returns/.test(line));
    expect(returns.length).toBeGreaterThanOrEqual(4);
    expect(returns.some((line) => line.includes("returns 24"))).toBe(true);
  });

  it("explains the base case", () => {
    expect(lines.some((line) => /`n <= 1` is true, so the body runs\./.test(line))).toBe(true);
  });
});

describe("errors", () => {
  const lines = transcript("exception");

  it("names the error and its message", () => {
    expect(lines.some((line) => /A ZeroDivisionError is raised: division by zero\./.test(line))).toBe(
      true,
    );
  });

  it("says the program carries on when it is caught", () => {
    expect(lines.some((line) => /caught here, and the program carries on/.test(line))).toBe(true);
  });

  it("says the call was abandoned rather than returning", () => {
    expect(lines.some((line) => /abandoned because of an error/.test(line))).toBe(true);
  });
});

describe("building a structure", () => {
  const lines = transcript("linked-build");

  it("describes construction in terms of the type", () => {
    expect(lines.some((line) => /A new Node is created\./.test(line))).toBe(true);
  });

  it("describes a field being pointed at another object", () => {
    expect(lines.some((line) => /`head\.next`|Node's `next`/.test(line))).toBe(true);
    expect(lines.some((line) => /a Node\./.test(line))).toBe(true);
  });
});

describe("control flow", () => {
  const lines = transcript("loop-break");

  it("explains a break", () => {
    expect(lines.some((line) => /`break` leaves the loop immediately\./.test(line))).toBe(true);
  });

  it("attributes the loop's end to the break", () => {
    expect(lines.some((line) => /ended because a break was reached/.test(line))).toBe(true);
  });

  it("counts iterations from one", () => {
    // "Iteration 0" is a programmer's convention, and this sentence is for someone who may not have it
    // yet. The loop variable's own value still reads exactly as the program set it.
    expect(lines.some((line) => /Iteration 1 begins\./.test(line))).toBe(true);
    expect(lines.some((line) => /Iteration 0 begins\./.test(line))).toBe(false);
  });
});

describe("input", () => {
  const lines = transcript("stdin");

  it("says the program is waiting, and what it asked", () => {
    expect(lines.some((line) => /waits for input, asking `Name:`/.test(line))).toBe(true);
  });

  it("reports what was supplied", () => {
    expect(lines.some((line) => /`Ada` is supplied as the input\./.test(line))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// properties of all narration
// ---------------------------------------------------------------------------

describe.each(NAMES)("every sentence in %s", (name) => {
  const lines = transcript(name);

  it("produces some narration", () => {
    expect(lines.length).toBeGreaterThan(0);
  });

  it("never leaks an event name or a placeholder", () => {
    for (const line of lines) {
      expect(line, "event type leaked into prose").not.toMatch(
        /\b(var_set|obj_set|frame_push|frame_pop|step_line|run_end|loop_iter)\b/,
      );
      expect(line, "placeholder left in prose").not.toMatch(/undefined|\[object|NaN|\{\}/);
      expect(line.trim().length).toBeGreaterThan(3);
    }
  });

  it("reads as a sentence", () => {
    for (const line of lines) {
      expect(line[0], `does not start with a capital: ${line}`).toMatch(/[A-Z`\d]/);
      expect(line.trimEnd().endsWith("."), `does not end with a full stop: ${line}`).toBe(true);
    }
  });

  it("never claims to know a condition's value", () => {
    // The trace records which way control went, never what the condition evaluated to — Python cannot
    // supply it and re-running the expression could change the program.
    for (const line of lines) {
      expect(line, `asserted a condition's value: ${line}`).not.toMatch(
        /evaluated to|the value of the condition/,
      );
    }
  });
});

describe("determinism", () => {
  it("describes the same trace identically every time", () => {
    for (const name of NAMES) {
      expect(transcript(name)).toEqual(transcript(name));
    }
  });

  it("gives the same sentence for a step however it was reached", () => {
    // Stepping forward to step 12 and rewinding to it must read the same, or the narration would be
    // describing the journey rather than the state.
    const forward = load("bubble-sort");
    for (let i = 0; i < 12; i++) forward.next();
    const forwardText = narrateCurrent(forward, options)?.sentences.map((s) => s.text);

    const backward = load("bubble-sort");
    backward.fastForward();
    backward.seekStep(forward.state.step);
    const backwardText = narrateCurrent(backward, options)?.sentences.map((s) => s.text);

    expect(backwardText).toEqual(forwardText);
  });
});

describe("the transcript", () => {
  it("is bounded so a long run cannot be rendered forever", () => {
    const store = load("bubble-sort");
    store.fastForward();
    const history = narrateHistory(store, { ...options, limit: 10 });
    expect(history.length).toBeLessThanOrEqual(10);
  });

  it("ends at the playhead, never ahead of it", () => {
    const store = load("bubble-sort");
    for (let i = 0; i < 8; i++) store.next();
    const history = narrateHistory(store, options);
    for (const entry of history) {
      expect(entry.step).toBeLessThanOrEqual(store.state.step);
    }
  });
});
