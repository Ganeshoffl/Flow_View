/**
 * Turning a trace into scrubbable state.
 *
 * `apply` holds the semantics of every event, `state` the live model they mutate, `store` the
 * playhead and navigation over them. Consumers should need nothing else to render a trace.
 */

export * from "./state.js";
export * from "./apply.js";
export * from "./snapshot.js";
export * from "./store.js";
