import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Trace } from "@flow-view/trace-schema";
import { TraceStore } from "@flow-view/trace-store";

import { parseSavedSession, serializeSession } from "../src/traceFiles.js";

const tracePath = new URL("../../../conformance/.traces/013-stdin.python.json", import.meta.url);
const sourcePath = new URL("../../../conformance/cases/013-stdin/main.py", import.meta.url);
const trace = JSON.parse(readFileSync(fileURLToPath(tracePath), "utf8")) as Trace;
const source = readFileSync(fileURLToPath(sourcePath), "utf8").replace(/\r\n/g, "\n");

describe("saved sessions", () => {
  it("restores a real input trace without executing its source", async () => {
    const loaded = await parseSavedSession(serializeSession(trace, source));
    expect(loaded.source).toBe(source);
    const store = new TraceStore();
    store.load(loaded.trace);
    store.fastForward();
    const output = store.state.output.map((entry) => entry.text).join("");
    expect(output).toBe("Ada 36\n");
    store.rewind();
    expect(store.state.output).toHaveLength(0);
    store.fastForward();
    expect(store.state.output.map((entry) => entry.text).join("")).toBe(output);
  });

  it("rejects invalid JSON and wrong formats", async () => {
    await expect(parseSavedSession("not json")).rejects.toThrow("valid JSON");
    await expect(parseSavedSession(JSON.stringify({ format: "other", source, trace }))).rejects.toThrow(
      "Unsupported",
    );
  });

  it("refuses a modified source or a corrupted trace", async () => {
    await expect(parseSavedSession(serializeSession(trace, source + "\n"))).rejects.toThrow(
      "does not match",
    );
    const corrupt = JSON.parse(serializeSession(trace, source));
    corrupt.trace.events[0].seq = "invalid";
    await expect(parseSavedSession(JSON.stringify(corrupt))).rejects.toThrow("Invalid trace");
  });
});
