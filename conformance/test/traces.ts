/**
 * What counts as a recorded trace on disk.
 *
 * Two suites read `.traces`, and both used to decide for themselves that a trace is "any .json file".
 * Adding a manifest alongside the traces promptly broke the other one, which tried to replay the
 * manifest as though it were a trace. One place should know.
 */

import { readdirSync } from "node:fs";

/** The manifest records which traces belong to a run. It is not itself a trace. */
export const MANIFEST = "manifest.json";

/** Recorded trace files in a directory, sorted, with non-traces excluded. */
export function listTraceFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== MANIFEST)
    .sort();
}
