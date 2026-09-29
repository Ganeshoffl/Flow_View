/**
 * The JavaScript adapter's public surface.
 *
 * `package.json` has named this file as the package entry since the adapter was scaffolded, and it did not
 * exist — so anything importing `@flow-view/adapter-javascript` by its package name would have failed. It
 * went unnoticed because everything so far reaches in by path: the CLI is spawned as a script, and the tests
 * import the modules directly.
 *
 * It matters for the Lite profile, which has to load this package in a browser worker rather than spawn it.
 */

export { RUNTIME, instrument } from "./instrument.js";
export { BudgetExceeded, Tracer } from "./runtime.js";
export { createLineReader } from "./stdin.js";
export {
  DEFAULT_CHUNK,
  DEFAULT_KEEP_HEAD,
  DEFAULT_KEEP_TAIL,
  DEFAULT_MIN_ITERATIONS,
  FOLDABLE,
  LoopCollapser,
} from "./collapse.js";
