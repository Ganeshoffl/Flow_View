/**
 * The engine, driven without a browser.
 *
 * The case that matters most here is the dullest one: running twice. A gate once reported that the
 * second "Run again" click never reached the server, and chasing it cost a day — the clicks were
 * landing on the wrong element and the engine had been innocent all along. These tests pin the
 * engine's half of that down so the question never has to be asked interactively again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServerEngine } from "../src/engine/serverEngine.js";
import type { EngineHandlers, RunOptions } from "../src/engine/types.js";

const BASE = "http://server.test";

/** A socket that records what was sent and lets a test drive the server side of the conversation. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  readonly sent: string[] = [];
  closed = false;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", {});
  }

  // --- the server's side ---

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", {});
  }

  deliver(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  get runRequest(): Record<string, unknown> | undefined {
    const raw = this.sent.find((s) => (JSON.parse(s) as { type: string }).type === "run");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
  }
}

interface Recorder extends EngineHandlers {
  readonly statuses: string[];
  readonly errors: string[];
  readonly events: unknown[];
}

function recorder(): Recorder {
  const statuses: string[] = [];
  const errors: string[] = [];
  const events: unknown[] = [];
  return {
    statuses,
    errors,
    events,
    onSession: () => undefined,
    onEvents: (incoming) => void events.push(...incoming),
    onStatus: (status) => void statuses.push(status),
    onError: (message) => void errors.push(message),
  };
}

const PROGRAM = (source: string): RunOptions => ({ source, language: "python" });

let posted: string[] = [];
let deleted: string[] = [];
let nextSessionId = 0;

beforeEach(() => {
  posted = [];
  deleted = [];
  nextSessionId = 0;
  FakeSocket.instances = [];

  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        posted.push(url);
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: `session-${++nextSessionId}` }),
        };
      }
      if (method === "DELETE") {
        deleted.push(url);
        return { ok: true, status: 204, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ languages: [] }) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Run, let the socket open, and finish — the whole lifecycle of one uneventful run. */
async function completeRun(engine: ServerEngine, source: string, handlers: Recorder) {
  await engine.run(PROGRAM(source), handlers);
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket was opened");
  socket.open();
  socket.deliver({ type: "complete" });
  return socket;
}

describe("running more than once", () => {
  it("creates a new session for every run", async () => {
    const engine = new ServerEngine(BASE);
    const handlers = recorder();

    await completeRun(engine, "a = 1\n", handlers);
    await completeRun(engine, "b = 2\n", handlers);
    await completeRun(engine, "c = 3\n", handlers);

    expect(posted).toEqual([
      `${BASE}/api/session`,
      `${BASE}/api/session`,
      `${BASE}/api/session`,
    ]);
  });

  it("sends the source it was given each time, not the first one", async () => {
    const engine = new ServerEngine(BASE);
    const handlers = recorder();

    await completeRun(engine, "first = 1\n", handlers);
    await completeRun(engine, "second = 2\n", handlers);

    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0]?.runRequest?.source).toBe("first = 1\n");
    expect(FakeSocket.instances[1]?.runRequest?.source).toBe("second = 2\n");
  });

  it("connects each run to its own session", async () => {
    const engine = new ServerEngine(BASE);
    const handlers = recorder();

    await completeRun(engine, "a = 1\n", handlers);
    await completeRun(engine, "b = 2\n", handlers);

    expect(FakeSocket.instances[0]?.url).toBe(`ws://server.test/api/session/session-1/ws`);
    expect(FakeSocket.instances[1]?.url).toBe(`ws://server.test/api/session/session-2/ws`);
  });

  it("closes the previous run's socket before opening the next", async () => {
    const engine = new ServerEngine(BASE);
    const handlers = recorder();

    const first = await completeRun(engine, "a = 1\n", handlers);
    first.readyState = FakeSocket.OPEN; // still open: a run the user never let finish
    await engine.run(PROGRAM("b = 2\n"), handlers);

    expect(first.closed).toBe(true);
  });

  it("reports the whole status cycle again on the second run", async () => {
    const engine = new ServerEngine(BASE);
    const handlers = recorder();

    await completeRun(engine, "a = 1\n", handlers);
    const afterFirst = handlers.statuses.length;
    await completeRun(engine, "b = 2\n", handlers);

    // The UI enables "Run again" off the back of these. If the second run reported nothing, the
    // button would sit at "finished" forever, which is exactly what the broken gate seemed to show.
    expect(handlers.statuses.slice(afterFirst)).toEqual(["starting", "running", "complete"]);
  });
});

describe("surviving React's development-mode double mount", () => {
  // StrictMode mounts, runs effect cleanups, and mounts again. The cleanup here calls dispose(), so
  // an engine reaches its first real run already disposed. It must still work.
  it("runs after being disposed before any run happened", async () => {
    const engine = new ServerEngine(BASE);
    const handlers = recorder();

    engine.dispose();
    await completeRun(engine, "a = 1\n", handlers);

    expect(posted).toHaveLength(1);
    expect(handlers.errors).toEqual([]);
    expect(handlers.statuses).toEqual(["starting", "running", "complete"]);
  });

  it("runs again after a dispose that followed a real run", async () => {
    const engine = new ServerEngine(BASE);
    const handlers = recorder();

    await completeRun(engine, "a = 1\n", handlers);
    engine.dispose();
    await completeRun(engine, "b = 2\n", handlers);

    expect(posted).toHaveLength(2);
    expect(handlers.errors).toEqual([]);
  });

  it("releases the server session on dispose, once", async () => {
    const engine = new ServerEngine(BASE);
    const handlers = recorder();

    await completeRun(engine, "a = 1\n", handlers);
    engine.dispose();
    engine.dispose();

    expect(deleted).toEqual([`${BASE}/api/session/session-1`]);
  });
});

describe("reporting trouble rather than hiding it", () => {
  it("says the server is unreachable instead of failing silently", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("connection refused"))));
    const engine = new ServerEngine(BASE);
    const handlers = recorder();

    await engine.run(PROGRAM("a = 1\n"), handlers);

    expect(handlers.statuses).toEqual(["starting", "error"]);
    expect(handlers.errors[0]).toMatch(/Could not reach the flow_view server/);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("recovers on the next run once the server is back", async () => {
    const working = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("connection refused"))));
    const engine = new ServerEngine(BASE);
    const handlers = recorder();
    await engine.run(PROGRAM("a = 1\n"), handlers);

    vi.stubGlobal("fetch", working);
    await completeRun(engine, "a = 1\n", handlers);

    expect(handlers.statuses).toEqual(["starting", "error", "starting", "running", "complete"]);
  });

  it("switches to awaiting-input when the program blocks on a read", async () => {
    const engine = new ServerEngine(BASE);
    const handlers = recorder();
    await engine.run(PROGRAM("x = input()\n"), handlers);
    const socket = FakeSocket.instances.at(-1)!;
    socket.open();

    socket.deliver({ type: "events", events: [{ t: "stdin_request", prompt: "name?" }] });
    expect(handlers.statuses.at(-1)).toBe("awaiting-input");

    socket.deliver({ type: "events", events: [{ t: "stdin_response", text: "Ada" }] });
    expect(handlers.statuses.at(-1)).toBe("running");
  });
});
