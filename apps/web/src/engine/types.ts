/**
 * The engine boundary.
 *
 * An engine runs a program and streams trace events. The Full profile talks to a local server over a
 * WebSocket; the Lite profile will run Pyodide in a Web Worker. Neither the UI nor the TraceStore
 * knows which it is using, which is the whole point — the same interface swaps underneath.
 *
 * Nothing here concerns playback. Stepping and scrubbing are operations on the TraceStore, and an
 * engine that had opinions about the playhead would drag re-execution back into a design that
 * deliberately does not need it.
 */

import type { Session, TraceEvent } from "@flow-view/trace-schema";

export type RunStatus = "idle" | "starting" | "running" | "awaiting-input" | "complete" | "error";

export interface LanguageSupport {
  readonly language: string;
  readonly available: boolean;
  readonly version?: string | null;
  readonly reason?: string | null;
  readonly remedy?: string | null;
  readonly planned?: string | null;
}

export interface Capabilities {
  readonly languages: readonly LanguageSupport[];
  readonly guards: Readonly<Record<string, boolean>>;
  /** Guards this platform cannot enforce. Reported so the UI never implies absent protection. */
  readonly inactive_guards: readonly string[];
  readonly profile: string;
  readonly platform: string;
}

export interface RunOptions {
  readonly source: string;
  readonly language: string;
  /** Input supplied up front, producing a trace that replays with no human involved. */
  readonly stdin?: string;
  readonly limits?: {
    readonly max_steps?: number;
    readonly wall_ms?: number;
    readonly memory_mb?: number;
    readonly output_bytes?: number;
  };
  /** Read the whole reachable heap each step. Correct at any size, affordable only when small. */
  readonly completeHeap?: boolean;
}

export interface EngineHandlers {
  onSession(session: Session, schema: string): void;
  onEvents(events: readonly TraceEvent[]): void;
  onStatus(status: RunStatus): void;
  /** A failure of the engine itself, not of the traced program. */
  onError(message: string, detail?: string): void;
}

export interface Engine {
  readonly kind: "server" | "worker";
  capabilities(): Promise<Capabilities>;
  run(options: RunOptions, handlers: EngineHandlers): Promise<void>;
  /** Answer a blocking read in the running program. */
  sendStdin(text: string): void;
  stop(): void;
  dispose(): void;
}
