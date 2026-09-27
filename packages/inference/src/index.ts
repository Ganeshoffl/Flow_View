/**
 * Working out what the objects in a trace are.
 *
 * One entry point, `inferStructures`, which reads the live heap and returns a shape per object with
 * the evidence for it. It runs client-side over the universal heap model, so every language gets the
 * same analysis from one implementation — see `docs/decisions/0003-where-inference-runs.md`.
 *
 * Three sources of belief, in increasing authority:
 *
 * 1. **an adapter's static hint** — a class whose `__init__` sets `self.next` looks like a list node
 *    before any instance exists, and when the list is empty this is the only evidence available;
 * 2. **runtime measurement** — what the objects actually do, which overrules the names they use;
 * 3. **the user** — who can see the picture and is therefore right.
 */

import type { Confidence, Shape, TraceEvent } from "@flow-view/trace-schema";
import type { ObjectLive, TraceState, TraceStore } from "@flow-view/trace-store";

import { type AccessPattern, type Inference, classifyContainer, classifyComponent } from "./classify.js";
import { findComponents } from "./measure.js";

export * from "./measure.js";
export * from "./classify.js";

export interface InferenceOptions {
  /** Shapes the user has corrected, by object id. Always wins. */
  readonly overrides?: ReadonlyMap<number, Shape>;
  /** Access history per object, for telling a stack from a queue. */
  readonly access?: ReadonlyMap<number, AccessPattern>;
}

export interface InferenceResult {
  readonly byObject: ReadonlyMap<number, Inference>;
  /** Objects that should be drawn as the head of a structure. */
  readonly roots: readonly number[];
}

export function inferStructures(
  state: TraceState,
  options: InferenceOptions = {},
): InferenceResult {
  const byObject = new Map<number, Inference>();

  // Linked structures first. A component's verdict covers all of its members, so an instance inside a
  // tree is not separately reported as a nondescript object.
  for (const component of findComponents(state)) {
    for (const inference of classifyComponent(state, component)) {
      byObject.set(inference.obj, inference);
    }
  }

  for (const obj of state.objects.values()) {
    if (obj.freed || byObject.has(obj.obj)) continue;
    const container = classifyContainer(state, obj, options.access?.get(obj.obj));
    if (container) {
      byObject.set(obj.obj, container);
      continue;
    }
    byObject.set(obj.obj, fallback(obj, state));
  }

  // An adapter's static hint fills gaps rather than overriding measurement. It is the only evidence
  // for an empty structure, and weaker than evidence for a populated one.
  applyAdapterHints(state, byObject);

  // The user has the last word. They can see the drawing.
  if (options.overrides) {
    for (const [objId, shape] of options.overrides) {
      const existing = byObject.get(objId);
      byObject.set(objId, {
        obj: objId,
        shape,
        confidence: "high",
        evidence: ["you chose this shape"],
        root: existing?.root ?? true,
        members: existing?.members ?? [objId],
        linkFields: existing?.linkFields ?? [],
      });
    }
  }

  const roots = [...byObject.values()]
    .filter((inference) => inference.root)
    .map((inference) => inference.obj)
    .sort((a, b) => a - b);

  return { byObject, roots };
}

/**
 * What to say about an object no rule recognised.
 *
 * `unknown` renders as a plain record with its references drawn — complete and correct, just not
 * clever. Claiming a shape here would be the one failure mode worth avoiding above all: a confident
 * picture of a structure the program does not have.
 */
function fallback(obj: ObjectLive, state: TraceState): Inference {
  const references = [...obj.slots.values()].filter((value) => "ref" in value).length;
  const evidence = [`${obj.typeName} with ${obj.slots.size} fields`];
  if (references > 0) {
    evidence.push(`${references} of them refer to other objects`);
  }
  evidence.push("no recognised shape, so it is drawn as plain fields");
  void state;
  return {
    obj: obj.obj,
    shape: obj.kind === "instance" ? "object" : "unknown",
    confidence: "low",
    evidence,
    root: true,
    members: [obj.obj],
    linkFields: [],
  };
}

function applyAdapterHints(state: TraceState, byObject: Map<number, Inference>): void {
  for (const obj of state.objects.values()) {
    if (obj.shape === undefined) continue;
    const current = byObject.get(obj.obj);
    if (current === undefined) continue;

    // Runtime evidence wins whenever there is any. A hint only decides the case where measurement
    // found nothing to go on.
    const runtimeSawNothing =
      current.shape === "unknown" || (current.shape === "object" && current.confidence === "low");
    if (!runtimeSawNothing) continue;

    byObject.set(obj.obj, {
      ...current,
      shape: obj.shape,
      confidence: weaken(obj.shapeConfidence ?? "low"),
      evidence: [
        ...(obj.shapeEvidence ?? [`the source suggests ${obj.shape.replace(/_/g, " ")}`]),
        "from the source, not from the objects themselves",
      ],
    });
  }
}

/** A static reading is never high confidence: source says intent, objects say fact. */
function weaken(confidence: Confidence): Confidence {
  return confidence === "high" ? "medium" : confidence;
}

// ---------------------------------------------------------------------------
// access patterns
// ---------------------------------------------------------------------------

/**
 * Collect how each container has been used, up to the playhead.
 *
 * Needed to tell a stack from a queue, which is not visible in a snapshot: both are lists, and the
 * difference is entirely in which end was used.
 */
export function collectAccess(store: TraceStore): Map<number, AccessPattern> {
  const counters = new Map<number, Mutable>();
  const counter = (objId: number): Mutable => {
    let found = counters.get(objId);
    if (!found) {
      found = { appends: 0, removalsAtEnd: 0, removalsAtStart: 0, insertsAtStart: 0, randomWrites: 0 };
      counters.set(objId, found);
    }
    return found;
  };

  // Mutations are read a *source line at a time*, because one operation on a list produces several
  // events and only the group reveals what it was.
  //
  // `del q[0]` on [1,2,3] arrives as set(0)=2, set(1)=3, delete(2): every position rewritten and the
  // last dropped. Read individually those are writes into the middle — the opposite of queue
  // behaviour. Read together they are unmistakably a shift left, so a removal from the front.
  //
  // Grouping by *step* was tried and is too coarse: effects are attributed to the line that caused
  // them but emitted after the next line's step event, so two consecutive deletions landed in one
  // group and cancelled each other out. Every mutation carries the line responsible, which is exactly
  // the grouping wanted.
  //
  // This is the price of positional slot keys, and recovering the intent here is cheaper than carrying
  // element identity through the entire trace.
  interface Operation {
    obj: number;
    key: string;
    op: string;
    /** An overwrite replaced something; a fill put a value where there was none. */
    overwrite: boolean;
  }

  const groups = new Map<string, Operation[]>();
  const order: string[] = [];

  for (let index = 0; index < store.position; index++) {
    const event: TraceEvent | undefined = store.eventAt(index);
    if (!event || event.t !== "obj_set") continue;
    const key = `${event.obj}@${event.line ?? -1}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)?.push({
      obj: event.obj,
      key: String(event.key),
      op: event.op,
      // Only a write that replaced a previous value is an overwrite. Filling a freshly built list
      // also arrives as `set`, and counting construction as random access stopped every list that
      // was built with a literal from ever being recognised as a stack or a queue.
      overwrite: event.prev !== undefined,
    });
  }

  for (const key of order) {
    const operations = groups.get(key) ?? [];
    if (operations.length === 0) continue;
    const counts = counter(operations[0]!.obj);

    const deletes = operations.filter((o) => o.op === "delete");
    const overwrites = operations.filter((o) => o.op === "set" && o.overwrite);
    const appends = operations.filter((o) => o.op === "append");
    const inserts = operations.filter((o) => o.op === "insert");

    const shiftedLeft = deletes.length === 1 && overwrites.length > 0 && appends.length === 0;
    const shiftedRight = appends.length === 1 && overwrites.length > 0 && deletes.length === 0;

    if (shiftedLeft) {
      counts.removalsAtStart++;
      continue;
    }

    if (shiftedRight) {
      // The append is the tail moving up to make room, not a push of its own.
      counts.insertsAtStart++;
      continue;
    }

    counts.appends += appends.length;
    counts.randomWrites += overwrites.length;

    for (const entry of deletes) {
      const position = Number(entry.key);
      if (Number.isNaN(position)) counts.randomWrites++;
      else if (position === 0) counts.removalsAtStart++;
      else counts.removalsAtEnd++;
    }

    for (const entry of inserts) {
      if (Number(entry.key) === 0) counts.insertsAtStart++;
      else counts.randomWrites++;
    }
  }

  return counters;
}

interface Mutable {
  appends: number;
  removalsAtEnd: number;
  removalsAtStart: number;
  insertsAtStart: number;
  randomWrites: number;
}
