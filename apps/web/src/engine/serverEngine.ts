/**
 * The Full profile engine: a local server over a WebSocket.
 *
 * A session is created over HTTP, then a socket carries the run. The socket is the reason this is a
 * live connection rather than a request and a response: a program that reads input has to stop
 * mid-flight and wait for a human, so its trace cannot be computed in advance.
 */

import type { Session, TraceEvent } from "@flow-view/trace-schema";

import type { Capabilities, Engine, EngineHandlers, RunOptions } from "./types.js";

interface ServerMessage {
  type: "session" | "events" | "complete" | "error" | "stopped" | "pong";
  schema?: string;
  session?: Session;
  events?: TraceEvent[];
  message?: string;
  detail?: string;
  exit_code?: number | null;
}

export class ServerEngine implements Engine {
  readonly kind = "server" as const;

  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private handlers: EngineHandlers | null = null;
  private disposed = false;

  constructor(private readonly baseUrl: string = "") {}

  async capabilities(): Promise<Capabilities> {
    const response = await fetch(`${this.baseUrl}/api/capabilities`);
    if (!response.ok) {
      throw new Error(`The server answered ${response.status} when asked what it can run.`);
    }
    return (await response.json()) as Capabilities;
  }

  async run(options: RunOptions, handlers: EngineHandlers): Promise<void> {
    this.handlers = handlers;
    handlers.onStatus("starting");

    this.closeSocket();

    let sessionId: string;
    try {
      const created = await fetch(`${this.baseUrl}/api/session`, { method: "POST" });
      if (!created.ok) throw new Error(`server answered ${created.status}`);
      sessionId = ((await created.json()) as { id: string }).id;
    } catch (error) {
      handlers.onStatus("error");
      handlers.onError(
        "Could not reach the flow_view server.",
        `Start it with \`flow-view\`, then try again. (${describe(error)})`,
      );
      return;
    }
    this.sessionId = sessionId;

    const socket = new WebSocket(this.socketUrl(sessionId));
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "run",
          language: options.language,
          source: options.source,
          stdin: options.stdin ?? null,
          limits: options.limits ?? null,
          complete_heap: options.completeHeap ?? false,
        }),
      );
      handlers.onStatus("running");
    });

    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        handlers.onError("The server sent something unreadable.");
        return;
      }
      this.dispatch(message, handlers);
    });

    socket.addEventListener("error", () => {
      // A socket error arrives without detail by design in browsers; the close event that follows
      // carries what little there is.
      handlers.onError("The connection to the server failed.");
    });

    socket.addEventListener("close", () => {
      if (this.disposed) return;
      this.socket = null;
    });
  }

  private dispatch(message: ServerMessage, handlers: EngineHandlers): void {
    switch (message.type) {
      case "session":
        if (message.session) {
          handlers.onSession(message.session, message.schema ?? "flow_view/trace@1");
        }
        break;

      case "events": {
        const events = message.events ?? [];
        handlers.onEvents(events);
        // A blocking read is the one thing that changes status mid-stream: the program is now
        // waiting on a person, and the UI has to say so rather than look stalled.
        for (const event of events) {
          if (event.t === "stdin_request") handlers.onStatus("awaiting-input");
          else if (event.t === "stdin_response") handlers.onStatus("running");
        }
        break;
      }

      case "complete":
        handlers.onStatus("complete");
        break;

      case "error":
        handlers.onStatus("error");
        handlers.onError(message.message ?? "The run failed.", message.detail ?? undefined);
        break;

      case "stopped":
        handlers.onStatus("complete");
        break;

      default:
        break;
    }
  }

  sendStdin(text: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "stdin", text }));
    }
  }

  stop(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "stop" }));
    }
    this.handlers?.onStatus("complete");
  }

  dispose(): void {
    this.disposed = true;
    this.closeSocket();
    // Ask the server to drop the session too. Without this a closed tab could leave a traced program
    // running with nobody watching it.
    if (this.sessionId) {
      const url = `${this.baseUrl}/api/session/${this.sessionId}`;
      void fetch(url, { method: "DELETE", keepalive: true }).catch(() => undefined);
      this.sessionId = null;
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
  }

  private socketUrl(sessionId: string): string {
    if (this.baseUrl) {
      return `${this.baseUrl.replace(/^http/, "ws")}/api/session/${sessionId}/ws`;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/api/session/${sessionId}/ws`;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
