/** Portable, offline session files. The source is kept outside the universal trace contract: the
 * header intentionally holds only a digest, and importing a trace must verify that the bundled source
 * really is what the adapter traced before it can be highlighted beside recorded steps. */
import { SCHEMA_ID, type Trace } from "@flow-view/trace-schema";

const FORMAT = "flow_view/session@1";
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface SavedSession {
  readonly format: typeof FORMAT;
  readonly source: string;
  readonly trace: Trace;
}

async function sourceDigest(source: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Source verification needs a secure browser context (localhost or HTTPS).");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Check an untrusted file before it is passed to TraceStore or shown as source code. */
export async function parseSavedSession(text: string): Promise<SavedSession> {
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) {
    throw new Error("The session exceeds the 64 MB import limit.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("The session is not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("The file is not a Flow_View session.");
  }
  const file = raw as Record<string, unknown>;
  if (file.format !== FORMAT || typeof file.source !== "string") {
    throw new Error("Unsupported Flow_View session format or missing source code.");
  }
  if (typeof file.trace !== "object" || file.trace === null || Array.isArray(file.trace)) {
    throw new Error("The session has no execution trace.");
  }
  const trace = file.trace as Trace;
  if (trace.schema !== SCHEMA_ID) {
    throw new Error("This trace schema is not supported by this version of Flow_View.");
  }
  const { validateTrace, checkTraceInvariants } = await import("@flow-view/trace-schema/validate");
  const shape = validateTrace(trace);
  if (!shape.valid) throw new Error(`Invalid trace: ${shape.errors[0]?.message ?? "unknown error"}`);
  const coherence = checkTraceInvariants(trace);
  if (!coherence.valid) {
    throw new Error(`Inconsistent trace: ${coherence.errors[0]?.message ?? "unknown error"}`);
  }
  const sourceFile = trace.session.source_files[0];
  if (!sourceFile || (await sourceDigest(file.source)) !== sourceFile.sha256) {
    throw new Error("The saved source does not match the source recorded in the trace.");
  }
  return { format: FORMAT, source: file.source, trace };
}

export function serializeSession(trace: Trace, source: string): string {
  return JSON.stringify({ format: FORMAT, source, trace } satisfies SavedSession);
}

export function sessionFileLimit(): number {
  return MAX_FILE_BYTES;
}
