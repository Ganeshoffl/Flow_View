/**
 * Plain-English narration, generated from the trace.
 *
 * No model, no network, no API key. Every sentence comes from a template and the facts the trace
 * already carries, which means it is instant, works offline, and says the same thing every time — and
 * that last property matters more than it sounds. A user comparing what they see against a tutorial,
 * or against what they saw a minute ago, needs the same program to be described the same way.
 */

import type { Language, Value } from "@flow-view/trace-schema";
import type { TraceState, TraceStore } from "@flow-view/trace-store";

import { type Sentence, narrateStep } from "./templates.js";
import { type StepGroup, currentGroup, groupSteps } from "./steps.js";

export * from "./steps.js";
export * from "./templates.js";

export interface NarrateOptions {
  readonly language: Language;
  /** Renders values as the rest of the UI does, so the prose and the panes agree. */
  readonly format: (value: Value | undefined, state: TraceState) => string;
}

export interface NarratedStep {
  readonly step: number;
  readonly index: number;
  readonly line: number | undefined;
  readonly sentences: readonly Sentence[];
}

/** Sentences for the step the playhead is on. */
export function narrateCurrent(store: TraceStore, options: NarrateOptions): NarratedStep | undefined {
  const group = currentGroup(store);
  if (!group) return undefined;
  return narrateGroup(group, store.state, options);
}

/**
 * Sentences for every step up to the playhead, newest last.
 *
 * Bounded by `limit`, because a transcript of a million-step run is not something anyone reads and
 * rendering it would cost more than the run did.
 */
export function narrateHistory(
  store: TraceStore,
  options: NarrateOptions & { limit?: number },
): NarratedStep[] {
  const limit = options.limit ?? 60;
  const events = store.allEvents().slice(0, store.position);
  const groups = groupSteps(events);
  const recent = groups.slice(Math.max(0, groups.length - limit));

  // State is the one at the playhead rather than at each step. Replaying to recompute per-step state
  // would be correct and far too slow to do while stepping; the difference only shows in how an object
  // is described, never in what the event says happened.
  return recent.map((group) => narrateGroup(group, store.state, options));
}

function narrateGroup(
  group: StepGroup,
  state: TraceState,
  options: NarrateOptions,
): NarratedStep {
  const sentences = narrateStep(group.events, {
    state,
    language: options.language,
    format: (value) => options.format(value, state),
  });

  return {
    step: group.step,
    index: group.index,
    line: group.anchor?.line,
    sentences,
  };
}
