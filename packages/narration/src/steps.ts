/**
 * Grouping a trace into the things that happened, step by step.
 *
 * A step is rarely one event. Landing on a line produces a `step_line`, then whatever that line's
 * predecessor turned out to have done: a `var_set`, some `obj_set`s, a metric or two. Narration has to
 * read the group, not the event, because the sentence worth saying is about the group.
 *
 * Grouping also lets a *pattern* be recognised. Two writes that exchange two values are a swap, and
 * saying "elements 1 and 2 were swapped" is worth more than two sentences each describing half of it.
 */

import { STEPPABLE_EVENT_TYPES, type EventType, type TraceEvent } from "@flow-view/trace-schema";
import type { TraceStore } from "@flow-view/trace-store";

export interface StepGroup {
  /** Step ordinal, or -1 for events before the first steppable one. */
  readonly step: number;
  /** The event the user lands on. */
  readonly anchor: TraceEvent | undefined;
  /** Everything belonging to this step, anchor included. */
  readonly events: readonly TraceEvent[];
  /** Index of the anchor in the store, for seeking. */
  readonly index: number;
}

const isSteppable = (event: TraceEvent): boolean =>
  STEPPABLE_EVENT_TYPES.has(event.t as EventType);

/** Split a trace into step groups, each a landable event followed by its effects. */
export function groupSteps(events: readonly TraceEvent[]): StepGroup[] {
  const groups: StepGroup[] = [];

  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (!isSteppable(event) && groups.length > 0) continue;

    // Where this group starts, and how far the run of non-steppable events after it reaches.
    let end = index;
    while (end + 1 < events.length && !isSteppable(events[end + 1]!)) end++;

    groups.push({
      step: event.step ?? -1,
      anchor: isSteppable(event) ? event : undefined,
      events: events.slice(index, end + 1),
      index,
    });
    index = end;
  }

  return groups;
}

/**
 * What has just happened, as of the playhead.
 *
 * Collected *backward* from the playhead, not forward. This matters and was originally wrong.
 *
 * Events are applied up to the playhead and no further, so the effects sitting after the current
 * anchor in the stream have not happened yet. Describing them meant narrating objects that were not in
 * state: `values` was reported as being "set to #1" because the list it points at had not been created
 * as far as the store was concerned.
 *
 * Collecting backward gives exactly the events whose effects the user can now see, which is what a
 * sentence in the present tense should be about.
 */
export function currentGroup(store: TraceStore): StepGroup | undefined {
  const events = store.allEvents();
  if (store.position === 0) return undefined;

  const last = store.position - 1;

  // Back to and including the event the user landed on. The playhead sits after that step's trailing
  // effects, so the steppable event is at or before it.
  let start = last;
  while (start > 0 && !isSteppable(events[start]!)) start--;

  const anchor = events[start];
  if (!anchor) return undefined;

  return {
    step: anchor.step ?? -1,
    anchor,
    events: events.slice(start, last + 1),
    index: start,
  };
}

// ---------------------------------------------------------------------------
// patterns
// ---------------------------------------------------------------------------

export interface Swap {
  readonly obj: number;
  readonly left: string;
  readonly right: string;
}

/**
 * Two writes to one object that exchange each other's values.
 *
 * Recognising this is the difference between "element 1 became 5, element 2 became 3" and "elements 1
 * and 2 were swapped" — which is what the program was doing, and what a sorting algorithm is made of.
 */
export interface Construction {
  readonly obj: number;
  readonly values: readonly TraceEvent[];
}

/**
 * An object being created and filled in one step.
 *
 * `values = [5, 1, 4, 2]` arrives as an allocation and four writes. Describing each separately gives
 * five sentences for one idea; describing it as construction gives one that says what the line did.
 */
export function detectConstruction(events: readonly TraceEvent[]): Construction | undefined {
  const created = events.find(
    (event): event is Extract<TraceEvent, { t: "obj_new" }> => event.t === "obj_new",
  );
  if (!created) return undefined;

  const fills = events.filter(
    (event): event is Extract<TraceEvent, { t: "obj_set" }> =>
      event.t === "obj_set" && event.obj === created.obj && event.prev === undefined,
  );
  // Only when the whole object was filled here. A partial fill is a mutation of something that already
  // existed, and saying "created holding ..." would misdescribe it.
  if (fills.length === 0) return undefined;
  if (created.length !== undefined && fills.length !== created.length) return undefined;

  return { obj: created.obj, values: fills };
}

export function detectSwap(events: readonly TraceEvent[]): Swap | undefined {
  const writes = events.filter(
    (event): event is Extract<TraceEvent, { t: "obj_set" }> =>
      event.t === "obj_set" && event.op === "set" && event.prev !== undefined,
  );
  if (writes.length !== 2) return undefined;

  const [first, second] = writes;
  if (!first || !second || first.obj !== second.obj) return undefined;

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  // Each write must have landed on what the other one displaced.
  if (!same(first.value, second.prev) || !same(second.value, first.prev)) return undefined;

  return { obj: first.obj, left: String(first.key), right: String(second.key) };
}
