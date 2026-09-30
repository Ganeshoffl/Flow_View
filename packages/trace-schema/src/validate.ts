/**
 * Schema validation, kept on a separate entry point.
 *
 * Validation pulls in Ajv, which the UI has no reason to ship. Importing
 * `@flow-view/trace-schema/validate` is an explicit opt-in, used by tests, by the conformance
 * suite, and by the server when an adapter is under development.
 */

// The schema is draft 2020-12, which Ajv's default export does not implement — that entry point
// is draft-07. `ajv/dist/2020` is the 2020-12 build. It ships as CommonJS, hence the interop dance.
import Ajv2020Import from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

import schema from "../generated/trace.schema.json" with { type: "json" };
import type { Trace, TraceEvent } from "./generated/types.js";

const Ajv2020 = ((Ajv2020Import as unknown as { default?: typeof Ajv2020Import }).default ??
  Ajv2020Import) as typeof Ajv2020Import;

type AjvInstance = InstanceType<typeof Ajv2020>;

let ajv: AjvInstance | undefined;
let traceValidator: ValidateFunction | undefined;
const eventValidators = new Map<string, ValidateFunction>();

function instance(): AjvInstance {
  ajv ??= new Ajv2020({
    allErrors: true,
    strict: false,
    // Events tolerate unknown members by design, so `additionalProperties: true` in the schema
    // must not be tightened here.
    allowUnionTypes: true,
  });
  return ajv;
}

export interface ValidationFailure {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationFailure[];
}

const OK: ValidationResult = { valid: true, errors: [] };

function present(errors: ErrorObject[] | null | undefined): ValidationResult {
  if (!errors?.length) return OK;
  // oneOf failures produce one error per rejected branch, which buries the useful one.
  // Report the deepest paths first: they are the specific complaints.
  const sorted = [...errors].sort(
    (a, b) => (b.instancePath?.length ?? 0) - (a.instancePath?.length ?? 0),
  );
  return {
    valid: false,
    errors: sorted.map((e) => ({
      path: e.instancePath || "/",
      message: e.message ?? "failed validation",
    })),
  };
}

/** Validate a whole trace document. */
export function validateTrace(candidate: unknown): ValidationResult {
  traceValidator ??= instance().compile(schema);
  return traceValidator(candidate) ? OK : present(traceValidator.errors);
}

/**
 * Validate a single event.
 *
 * Streaming adapters produce events one at a time and there is no whole document to check yet,
 * so this compiles a validator per event type against the corresponding `$defs` entry.
 */
export function validateEvent(candidate: unknown): ValidationResult {
  const type = (candidate as { t?: unknown } | null)?.t;
  if (typeof type !== "string") {
    return { valid: false, errors: [{ path: "/t", message: "event has no type" }] };
  }
  const key = `Event_${type}`;
  if (!(key in (schema.$defs as Record<string, unknown>))) {
    // Unknown event types are forward compatibility, not errors: a newer adapter within the
    // same major version may emit events this build has never heard of.
    return OK;
  }
  let validator = eventValidators.get(type);
  if (!validator) {
    // Only $defs and the $ref may be carried over. In 2020-12 a $ref is *combined* with its
    // sibling keywords rather than replacing them, so spreading the whole document would leave
    // the root's `required` and `additionalProperties` in force and validate the event against
    // the trace envelope.
    validator = instance().compile({
      $schema: schema.$schema,
      $id: `urn:flow-view:event:${type}`,
      $ref: `#/$defs/${key}`,
      $defs: schema.$defs,
    });
    eventValidators.set(type, validator);
  }
  return validator(candidate) ? OK : present(validator.errors);
}

/** Validate every event, reporting each failure with its index. */
export function validateEvents(events: readonly unknown[]): ValidationResult {
  const errors: ValidationFailure[] = [];
  events.forEach((event, i) => {
    const result = validateEvent(event);
    for (const e of result.errors) {
      errors.push({ path: `/events/${i}${e.path === "/" ? "" : e.path}`, message: e.message });
    }
  });
  return errors.length ? { valid: false, errors } : OK;
}

/** Throw on an invalid trace, with the first few failures in the message. */
export function assertValidTrace(candidate: unknown): asserts candidate is Trace {
  const result = validateTrace(candidate);
  if (!result.valid) {
    const shown = result.errors
      .slice(0, 5)
      .map((e) => `  ${e.path}: ${e.message}`)
      .join("\n");
    const more = result.errors.length > 5 ? `\n  …and ${result.errors.length - 5} more` : "";
    throw new Error(`Trace failed schema validation:\n${shown}${more}`);
  }
}

/**
 * Structural invariants the JSON Schema cannot express.
 *
 * A trace can be schema-valid and still incoherent — sequence numbers out of order, a frame
 * popped that was never pushed. These are the checks the conformance suite runs against every
 * adapter, and the reason a new language cannot quietly invent its own dialect.
 */
export function checkTraceInvariants(trace: Trace): ValidationResult {
  const errors: ValidationFailure[] = [];
  const at = (i: number) => `/events/${i}`;

  let lastSeq = -1;
  let lastStep = -1;
  const openFrames: number[] = [];
  const liveObjects = new Set<number>();
  let ended = false;

  trace.events.forEach((event: TraceEvent, i) => {
    if (event.seq <= lastSeq) {
      errors.push({ path: at(i), message: `seq ${event.seq} is not greater than ${lastSeq}` });
    }
    lastSeq = event.seq;

    if (event.step !== undefined) {
      if (event.step < lastStep) {
        errors.push({ path: at(i), message: `step ${event.step} went backwards from ${lastStep}` });
      }
      lastStep = event.step;
    }

    if (ended) {
      errors.push({ path: at(i), message: `event follows run_end` });
    }

    switch (event.t) {
      case "run_start":
        if (i !== 0) errors.push({ path: at(i), message: "run_start is not the first event" });
        break;
      case "run_end":
        ended = true;
        break;
      case "frame_push":
        openFrames.push(event.frame ?? -1);
        break;
      case "frame_pop": {
        // Closed by name, not by position. Frames used to have to close innermost-first, which is true of a
        // program doing one thing at a time and false of any program that does not: two `async` calls waiting on
        // something both have open frames, and whichever finishes first closes first. What still has to hold is
        // that a frame may only be closed if it was opened, and only once.
        if (openFrames.length === 0) {
          errors.push({ path: at(i), message: "frame_pop with no open frame" });
        } else if (event.frame !== undefined) {
          const index = openFrames.lastIndexOf(event.frame);
          if (index < 0) {
            errors.push({
              path: at(i),
              message: `frame_pop closed frame ${event.frame}, which was not open`,
            });
          } else {
            openFrames.splice(index, 1);
          }
        } else {
          openFrames.pop();
        }
        break;
      }
      case "obj_new":
        if (liveObjects.has(event.obj)) {
          errors.push({ path: at(i), message: `object ${event.obj} allocated twice` });
        }
        liveObjects.add(event.obj);
        break;
      case "obj_set":
      case "obj_resize":
        if (!liveObjects.has(event.obj)) {
          errors.push({ path: at(i), message: `mutation of unknown object ${event.obj}` });
        }
        break;
      case "obj_free":
        if (!liveObjects.delete(event.obj)) {
          errors.push({ path: at(i), message: `free of unknown object ${event.obj}` });
        }
        break;
      default:
        break;
    }
  });

  if (trace.events.length > 0) {
    if (trace.events[0]?.t !== "run_start") {
      errors.push({ path: "/events/0", message: "trace does not begin with run_start" });
    }
    if (!ended) {
      errors.push({ path: "/events", message: "trace has no run_end" });
    }
  }
  if (openFrames.length > 0) {
    errors.push({
      path: "/events",
      message: `${openFrames.length} frame(s) never popped: ${openFrames.join(", ")}`,
    });
  }

  return errors.length ? { valid: false, errors } : OK;
}
