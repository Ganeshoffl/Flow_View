/**
 * The Universal Trace contract.
 *
 * Types are generated from `model/trace.model.json`; this module re-exports them and adds the
 * small runtime helpers that both adapters and renderers need. Nothing here interprets a trace —
 * that is the TraceStore's job. This package only describes what a trace *is*.
 */

export * from "./generated/types.js";

import {
  SCHEMA_ID,
  SCHEMA_VERSION_MAJOR,
  type Primitive,
  type Value,
  type ValueAddr,
  type ValuePrim,
  type ValueRef,
  type ValueUnavailable,
} from "./generated/types.js";

// ---------------------------------------------------------------------------
// Value construction
// ---------------------------------------------------------------------------

/** Wrap an immediate value. */
export const prim = (v: Primitive): ValuePrim => ({ prim: v });

/** Wrap a large integer that cannot survive a double, carried as a string. */
export const bigintValue = (digits: string): ValuePrim => ({ prim: digits, bigint: true });

/** Wrap a string that was shortened for transport. */
export const truncatedString = (text: string, fullLength: number): ValuePrim => ({
  prim: text,
  truncated: fullLength,
});

/** Reference a heap object by id. */
export const ref = (objId: number): ValueRef => ({ ref: objId });

/** A native pointer. */
export const addr = (address: string, type: string, dangling = false): ValueAddr =>
  dangling ? { addr: address, type, dangling: true } : { addr: address, type };

/**
 * A value the runtime would not report, with the reason why.
 *
 * Used deliberately and often. A debugger cannot always read a value, and saying so is the
 * honest answer — a fabricated number would silently teach the user something false.
 */
export const unavailable = (reason: string): ValueUnavailable => ({ unavailable: reason });

// ---------------------------------------------------------------------------
// Value inspection
// ---------------------------------------------------------------------------

export const isPrim = (v: Value): v is ValuePrim => "prim" in v;
export const isRef = (v: Value): v is ValueRef => "ref" in v;
export const isAddr = (v: Value): v is ValueAddr => "addr" in v;
export const isUnavailable = (v: Value): v is ValueUnavailable => "unavailable" in v;

/** Heap id a value points at, or null when it does not point at one. */
export function refTarget(v: Value | undefined): number | null {
  return v && isRef(v) ? v.ref : null;
}

/**
 * Structural equality for values.
 *
 * Compares identity for references — two `ref` values are equal when they point at the same
 * object, which is exactly the question the variables view asks when it highlights aliasing.
 */
export function valueEquals(a: Value | undefined, b: Value | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (isPrim(a) && isPrim(b)) {
    return a.prim === b.prim && (a.bigint ?? false) === (b.bigint ?? false);
  }
  if (isRef(a) && isRef(b)) return a.ref === b.ref;
  if (isAddr(a) && isAddr(b)) return a.addr === b.addr && a.type === b.type;
  if (isUnavailable(a) && isUnavailable(b)) return a.unavailable === b.unavailable;
  return false;
}

// ---------------------------------------------------------------------------
// Schema compatibility
// ---------------------------------------------------------------------------

/** Parse a schema id such as `flow_view/trace@1` into its major version. */
export function schemaMajor(schemaId: string): number | null {
  const m = /^flow_view\/trace@(\d+)$/.exec(schemaId);
  return m?.[1] ? Number.parseInt(m[1], 10) : null;
}

export class UnsupportedSchemaError extends Error {
  constructor(
    readonly found: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsupportedSchemaError";
  }
}

/**
 * Reject a trace this build cannot interpret, with a message that says what is wrong.
 *
 * Additive changes stay within a major version and consumers must ignore unknown event types
 * and unknown fields, so only a major mismatch is fatal.
 */
export function assertSupportedSchema(schemaId: string): void {
  const major = schemaMajor(schemaId);
  if (major === null) {
    throw new UnsupportedSchemaError(
      schemaId,
      `Not a flow_view trace: expected a schema id like "${SCHEMA_ID}", found "${schemaId}".`,
    );
  }
  if (major !== SCHEMA_VERSION_MAJOR) {
    const dir = major > SCHEMA_VERSION_MAJOR ? "newer" : "older";
    throw new UnsupportedSchemaError(
      schemaId,
      `This trace uses schema version ${major}, which is ${dir} than the version ` +
        `${SCHEMA_VERSION_MAJOR} this build understands. ` +
        (dir === "newer" ? "Update flow_view to open it." : "It was written by an older release."),
    );
  }
}
