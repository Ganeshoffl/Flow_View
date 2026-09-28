/**
 * Reading input synchronously.
 *
 * The risk here is not a wrong answer, it is a hang. A tracer that sits forever on a read looks exactly like
 * one that has crashed, so "runs out of input and says so" matters more than any of the happy paths.
 */

import { closeSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLineReader } from "../src/stdin.js";

const open = [];

/** A file descriptor holding exactly this text. A regular file reads the same way a pipe does here. */
function fdWith(text) {
  const dir = mkdtempSync(join(tmpdir(), "flow-view-stdin-"));
  const path = join(dir, "input");
  writeFileSync(path, text, "utf8");
  const fd = openSync(path, "r");
  open.push(fd);
  return fd;
}

afterEach(() => {
  while (open.length > 0) {
    try {
      closeSync(open.pop());
    } catch {
      /* already gone */
    }
  }
});

describe("reading lines", () => {
  it("hands back one line at a time", () => {
    const reader = createLineReader(fdWith("Ada\n36\n"));
    expect(reader.readLine()).toBe("Ada");
    expect(reader.readLine()).toBe("36");
  });

  it("keeps the surplus from one read for the next call", () => {
    // A pipe hands over whatever has arrived, which may be several lines at once. Throwing the remainder
    // away would lose every answer after the first.
    const reader = createLineReader(fdWith("one\ntwo\nthree\n"));
    expect([reader.readLine(), reader.readLine(), reader.readLine()]).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("counts a last line with no newline as a line", () => {
    const reader = createLineReader(fdWith("alone"));
    expect(reader.readLine()).toBe("alone");
    expect(reader.readLine()).toBeNull();
  });

  it("returns an empty line for an empty line", () => {
    // Distinct from "no more input". A program reading a blank answer should see a blank answer.
    const reader = createLineReader(fdWith("\nx\n"));
    expect(reader.readLine()).toBe("");
    expect(reader.readLine()).toBe("x");
  });

  it("keeps returning null once the input is exhausted", () => {
    const reader = createLineReader(fdWith("only\n"));
    expect(reader.readLine()).toBe("only");
    expect(reader.readLine()).toBeNull();
    expect(reader.readLine()).toBeNull();
  });

  it("says there is nothing rather than waiting, when there was never anything", () => {
    const reader = createLineReader(fdWith(""));
    expect(reader.readLine()).toBeNull();
  });

  it("reads a line longer than one chunk", () => {
    const long = "x".repeat(20000);
    const reader = createLineReader(fdWith(`${long}\n`));
    expect(reader.readLine()).toBe(long);
  });

  it("handles text that is not ASCII", () => {
    const reader = createLineReader(fdWith("café ☕\n"));
    expect(reader.readLine()).toBe("café ☕");
  });
});
