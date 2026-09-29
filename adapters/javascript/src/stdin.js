/**
 * Reading a line of input synchronously.
 *
 * The program being traced must block on input the way it would outside flow_view: `prompt()` returns a
 * string, and the statement after it runs once the answer is there. Everything about the trace depends on
 * that — a step is "the program was here, then it was there", and an asynchronous read would split one
 * statement into two halves with an event loop turn in between.
 *
 * Node has no synchronous line read, so this builds one out of `readSync` on the file descriptor. Three
 * things make that safe rather than merely possible:
 *
 * **It cannot spin.** A pipe with no data yet fails with `EAGAIN`, and retrying immediately would burn a
 * core. The wait uses `Atomics.wait`, which is the only way to sleep synchronously in JavaScript, so a
 * blocked read costs nothing.
 *
 * **It cannot hang forever.** Every read is bounded by a deadline. Waiting forever for input that is never
 * coming is indistinguishable, from the outside, from a tracer that has crashed.
 *
 * **Partial reads are normal.** A pipe hands over whatever has arrived, which may be half a line or three
 * lines at once. The surplus is kept for the next call rather than discarded.
 */

import { readSync } from "node:fs";

/** Somewhere to sleep on. `Atomics.wait` needs a shared integer, and never observes a change to this one. */
const PARKED = new Int32Array(new SharedArrayBuffer(4));

/** How long to sleep between attempts when there is no input yet. */
const POLL_MS = 5;

const CHUNK = 8192;

/**
 * A reader over one file descriptor.
 *
 * @param {number} fd
 * @param {{ deadlineMs?: number }} [options] how long a single `readLine` may wait for input
 */
export function createLineReader(fd = 0, options = {}) {
  const deadlineMs = options.deadlineMs ?? 30000;
  let pending = "";
  let atEnd = false;

  /**
   * The next line, without its newline, or `null` once input is exhausted.
   *
   * @returns {string | null}
   */
  function readLine() {
    const giveUpAt = Date.now() + deadlineMs;

    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        return line;
      }

      if (atEnd) {
        // A final line with no trailing newline still counts as a line.
        if (pending.length === 0) return null;
        const rest = pending;
        pending = "";
        return rest;
      }

      const buffer = Buffer.allocUnsafe(CHUNK);
      let read = 0;
      try {
        read = readSync(fd, buffer, 0, CHUNK, null);
      } catch (error) {
        const code = error?.code;
        if (code === "EAGAIN") {
          if (Date.now() >= giveUpAt) return null;
          Atomics.wait(PARKED, 0, 0, POLL_MS);
          continue;
        }
        // Both mean the same thing here: there is no more input to be had.
        if (code === "EOF" || code === "EPIPE") {
          atEnd = true;
          continue;
        }
        throw error;
      }

      if (read === 0) {
        atEnd = true;
        continue;
      }
      pending += buffer.toString("utf8", 0, read);
    }
  }

  return { readLine };
}
