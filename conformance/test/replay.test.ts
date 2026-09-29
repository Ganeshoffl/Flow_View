/**
 * Replaying real adapter output.
 *
 * The Python suite checks that traces are well formed and say the right things. This checks that the
 * TraceStore can *replay* them — forwards, backwards, and to arbitrary positions — using traces
 * produced by the actual adapter rather than written by hand.
 *
 * That distinction is the point. Phase 0 built the store against fixtures I wrote myself, which
 * means it was verified against my idea of what a trace looks like. This closes the loop: the same
 * battery of properties, applied to what a real tracer really emits.
 *
 * Traces come from `python conformance/runner.py`. If they are absent the suite fails rather than
 * skipping — a silently skipped verification is worse than none, because it looks like a pass.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkTraceInvariants, validateTrace } from "@flow-view/trace-schema/validate";
import type { Trace } from "@flow-view/trace-schema";
import {
  TraceStore,
  captureState,
  compareStates,
  createState,
  describeDifferences,
} from "@flow-view/trace-store";

import { MANIFEST, listTraceFiles } from "./traces.js";

const here = dirname(fileURLToPath(import.meta.url));
const TRACE_DIR = join(here, "..", ".traces");

interface Recorded {
  readonly name: string;
  readonly trace: Trace;
}

function loadRecorded(): Recorded[] {
  let files: string[];
  try {
    files = listTraceFiles(TRACE_DIR);
  } catch {
    throw new Error(
      `No recorded traces in ${TRACE_DIR}.\n` +
        "Generate them first:  python conformance/runner.py\n" +
        "This suite verifies real adapter output, so it cannot run without it.",
    );
  }
  if (files.length === 0) {
    throw new Error(`${TRACE_DIR} is empty. Run: python conformance/runner.py`);
  }

  // Insist the set of traces is the set the generator meant to write.
  //
  // This directory is not version controlled, and the suite reads the *directory* — so a trace left
  // behind by another branch goes on being replayed as though it belonged here. One did, and this
  // suite reported fifteen extra passing tests for a corpus entry the checked-out code did not
  // contain. Replaying output from code that is no longer present proves nothing about the code that
  // is.
  const expected = readManifest();
  const found = files.map((name) => name.replace(/\.json$/, "")).sort();
  const stale = found.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !found.includes(name));
  if (stale.length > 0 || missing.length > 0) {
    throw new Error(
      "The recorded traces do not match the corpus that produced them.\n" +
        (stale.length > 0 ? `  left over from another run: ${stale.join(", ")}\n` : "") +
        (missing.length > 0 ? `  recorded but now absent: ${missing.join(", ")}\n` : "") +
        "Regenerate them:  python conformance/runner.py",
    );
  }

  return files.sort().map((name) => ({
    name: name.replace(/\.json$/, ""),
    trace: JSON.parse(readFileSync(join(TRACE_DIR, name), "utf8")) as Trace,
  }));
}

function readManifest(): string[] {
  const path = join(TRACE_DIR, MANIFEST);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `${path} is missing, so there is no way to tell which traces belong to this commit.\n` +
        "Regenerate them:  python conformance/runner.py",
    );
  }
  const parsed = JSON.parse(raw) as { traces?: unknown };
  if (!Array.isArray(parsed.traces)) {
    throw new Error(`${path} has no trace list. Regenerate: python conformance/runner.py`);
  }
  return [...(parsed.traces as string[])].sort();
}

const recorded = loadRecorded();

describe("recorded adapter traces", () => {
  it("there are traces to check", () => {
    expect(recorded.length).toBeGreaterThanOrEqual(15);
  });
});

describe.each(recorded.map((entry) => [entry.name, entry] as const))(
  "%s",
  (name, entry) => {
    const { trace } = entry;

    it("validates against the schema in TypeScript too", () => {
      // The Python validator already passed this trace. Both are generated from one model, so a
      // disagreement here means the generator produced two different contracts.
      const result = validateTrace(trace);
      const detail = result.errors
        .slice(0, 5)
        .map((e) => `${e.path}: ${e.message}`)
        .join("\n");
      expect(result.valid, `${name} failed TypeScript validation:\n${detail}`).toBe(true);
    });

    it("satisfies the structural invariants", () => {
      const result = checkTraceInvariants(trace);
      const detail = result.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
      expect(result.valid, `${name} violated invariants:\n${detail}`).toBe(true);
    });

    it("loads and reports a sensible shape", () => {
      const store = new TraceStore();
      store.load(trace);
      expect(store.eventCount).toBeGreaterThan(0);
      expect(store.stepCount).toBeGreaterThan(0);
      expect(store.isComplete, "every trace must end with run_end").toBe(true);
    });

    it("is exactly invertible over a full round trip", () => {
      // The guarantee backward stepping rests on, now tested against real output.
      const store = new TraceStore();
      store.load(trace);

      store.fastForward();
      expect(store.isAtEnd).toBe(true);

      store.rewind();
      expect(store.isAtStart).toBe(true);

      const diffs = compareStates(store.state, createState());
      expect(
        diffs.length,
        `${name} did not return to its initial state.\n${describeDifferences(diffs)}`,
      ).toBe(0);
    });

    it("reaches the same state whether stepped forward or rewound to", () => {
      const forward = new TraceStore();
      forward.load(trace);
      const backward = new TraceStore();
      backward.load(trace);
      backward.fastForward();

      // Every event boundary, not only the steps a user can land on: bookkeeping events mutate state
      // too, and an asymmetric handler for one of them is exactly what this catches.
      const stride = Math.max(1, Math.floor(forward.eventCount / 400));
      for (let position = 0; position <= forward.eventCount; position += stride) {
        forward.seekEvent(position);
        backward.seekEvent(position);
        const diffs = compareStates(forward.state, backward.state);
        expect(
          diffs.length,
          `${name} diverged at event ${position} depending on direction of approach.\n` +
            describeDifferences(diffs),
        ).toBe(0);
      }
    });

    it("walks every step forward and back without throwing", () => {
      const store = new TraceStore();
      store.load(trace);
      let forwards = 0;
      while (store.next()) forwards++;
      let backwards = 0;
      while (store.prev()) backwards++;
      expect(forwards).toBeGreaterThan(0);
      expect(backwards).toBe(forwards);
      expect(store.isAtStart).toBe(true);
    });

    it("captures a snapshot consistent with replayed state", () => {
      const store = new TraceStore();
      store.load(trace);
      store.fastForward();
      const snapshot = captureState(store.state);
      expect(snapshot.frames.length).toBe(store.state.frames.size);
      expect(snapshot.objects.length).toBe(store.state.objects.size);
      expect(snapshot.frame_order).toEqual(store.state.frameOrder);
    });

    it("never references an object it did not announce", () => {
      // The store throws on a mutation to an unknown object, so a full replay is itself the check.
      const store = new TraceStore();
      expect(() => {
        store.load(trace);
        store.fastForward();
      }).not.toThrow();
    });
  },
);

describe("cross-language agreement", () => {
  it("every language traces every case it has a source for", () => {
    // With one adapter this is a formality. When JavaScript lands it becomes the assertion that both
    // adapters describe the same program the same way.
    const byCase = new Map<string, string[]>();
    for (const { name } of recorded) {
      const [caseName, language] = splitName(name);
      byCase.set(caseName, [...(byCase.get(caseName) ?? []), language]);
    }
    for (const [caseName, languages] of byCase) {
      expect(languages.length, `${caseName} has no adapter output`).toBeGreaterThan(0);
    }
  });

  it("the same case produces the same final output in every language", () => {
    const outputs = new Map<string, Map<string, string>>();
    for (const { name, trace } of recorded) {
      const [caseName, language] = splitName(name);
      const text = trace.events
        .filter((event) => event.t === "stdout")
        .map((event) => (event.t === "stdout" ? event.text : ""))
        .join("");
      const perCase = outputs.get(caseName) ?? new Map<string, string>();
      perCase.set(language, text);
      outputs.set(caseName, perCase);
    }

    for (const [caseName, perLanguage] of outputs) {
      // A case may declare that one language's *printed text* differs, and only that: `print(None)` writes
      // "None" where `console.log(null)` writes "null". The declaration is not a way to excuse a
      // disagreement after the fact — it is checked exactly, and every language that did not declare one
      // still has to agree with the others.
      const declared = declaredOutputs(caseName);
      const undeclared = new Map<string, string>();

      for (const [language, text] of perLanguage) {
        const expected = declared.get(language);
        if (expected === undefined) {
          undeclared.set(language, text);
        } else {
          expect(
            text,
            `${caseName} [${language}] declares its own stdout in case.json, so it must print exactly that`,
          ).toBe(expected);
        }
      }

      const distinct = new Set(undeclared.values());
      expect(
        distinct.size,
        `${caseName} printed different things in different languages: ` +
          JSON.stringify([...undeclared]) +
          ". If this is a difference in the language's own surface rather than in the adapter, declare it " +
          "as expect_per_language.<language>.stdout in the case.",
      ).toBeLessThanOrEqual(1);
    }
  });
});

const CASE_DIR = join(here, "..", "cases");

/**
 * Per-language stdout a case has explicitly declared, keyed by language.
 *
 * Read from the case rather than hardcoded here, so the corpus stays the single place that decides what a
 * case expects. The Python runner reads the same field and refuses to let it restate anything but surface.
 */
function declaredOutputs(caseName: string): Map<string, string> {
  const out = new Map<string, string>();
  let raw: string;
  try {
    raw = readFileSync(join(CASE_DIR, caseName, "case.json"), "utf8");
  } catch {
    return out;
  }
  const meta = JSON.parse(raw) as {
    expect_per_language?: Record<string, { stdout?: string }>;
  };
  for (const [language, override] of Object.entries(meta.expect_per_language ?? {})) {
    if (typeof override?.stdout === "string") out.set(language, override.stdout);
  }
  return out;
}

function splitName(name: string): [string, string] {
  const index = name.lastIndexOf(".");
  return index < 0 ? [name, "unknown"] : [name.slice(0, index), name.slice(index + 1)];
}
