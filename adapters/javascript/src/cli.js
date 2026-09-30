#!/usr/bin/env node
/**
 * Command-line entry point for the JavaScript tracer.
 *
 * Mirrors the Python CLI deliberately: same flags, same JSON Lines on stdout, header first. The server
 * spawns either of them the same way, and anything it has to special-case is a place where the two
 * adapters have been allowed to drift.
 *
 * As there, the program's own output never reaches the real stdout — `console.log` is intercepted and
 * turned into trace events, so output stays attributed to the step that produced it.
 *
 * Usage:
 *   node src/cli.js --source program.js [--max-steps N]
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { RUNTIME, instrument } from "./instrument.js";
import { BudgetExceeded, Tracer } from "./runtime.js";
import { createLineReader } from "./stdin.js";
import {
  DEFAULT_CHUNK,
  DEFAULT_KEEP_HEAD,
  DEFAULT_KEEP_TAIL,
  DEFAULT_MIN_ITERATIONS,
  LoopCollapser,
} from "./collapse.js";

function parseArgs(argv) {
  const args = {
    maxSteps: 200000,
    wallMs: 30000,
    outputBytes: 1048576,
    sessionId: "local",
    // On by default, like the Python adapter. `--no-collapse` is there for anyone who needs the raw article.
    collapse: true,
    collapseKeep: null,
    collapseChunk: null,
    collapseMin: null,
  };
  args.unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--source") args.source = next();
    else if (flag === "--session-id") args.sessionId = next();
    else if (flag === "--max-steps") args.maxSteps = Number(next());
    else if (flag === "--wall-ms") args.wallMs = Number(next());
    else if (flag === "--output-bytes") args.outputBytes = Number(next());
    else if (flag === "--no-collapse") args.collapse = false;
    else if (flag === "--collapse-keep") args.collapseKeep = Number(next());
    else if (flag === "--collapse-chunk") args.collapseChunk = Number(next());
    else if (flag === "--collapse-min") args.collapseMin = Number(next());
    // Accepted and ignored, on purpose. The server sends the same flags to every adapter, and a memory
    // ceiling for JavaScript is V8's business — it is applied by the caller as `--max-old-space-size`
    // before this script ever runs, so there is nothing to do with the number here.
    else if (flag === "--memory-mb") args.memoryMb = Number(next());
    // Python walks its whole heap for this. The JavaScript adapter has no cheaper and fuller mode to
    // switch between, so the flag is accepted to keep the two CLIs interchangeable and changes nothing.
    else if (flag === "--complete-heap") args.completeHeap = true;
    // Anything else is drift between the two adapters, and drift should be visible. Reported as a note
    // rather than an error: refusing to run because of an unrecognised flag would turn a small
    // inconsistency into a failed run.
    else args.unknown.push(flag);
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.source) {
    process.stdout.write(
      JSON.stringify({ seq: 0, t: "note", level: "warn", text: "--source is required" }) + "\n",
    );
    return 2;
  }

  let source;
  try {
    source = readFileSync(args.source, "utf8");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ seq: 0, t: "note", level: "warn", text: String(error.message) }) + "\n",
    );
    return 2;
  }

  const path = basename(args.source);
  const write = (event) => process.stdout.write(JSON.stringify(event) + "\n");

  const collapser = args.collapse
    ? new LoopCollapser({
        keepHead: args.collapseKeep ?? DEFAULT_KEEP_HEAD,
        keepTail: args.collapseKeep ?? DEFAULT_KEEP_TAIL,
        chunk: args.collapseChunk ?? DEFAULT_CHUNK,
        minIterations: args.collapseMin ?? DEFAULT_MIN_ITERATIONS,
      })
    : null;

  const tracer = new Tracer({
    path,
    emit: write,
    limits: { maxSteps: args.maxSteps, wallMs: args.wallMs, outputBytes: args.outputBytes },
    collapser,
  });
  tracer.lineCount = source.split("\n").length;

  // Instrumenting can fail on a program that does not parse, and that is a result rather than a crash:
  // the user gets told which line, the same way the Python adapter reports a SyntaxError.
  let instrumented;
  try {
    instrumented = instrument(source, { path });
  } catch (error) {
    const header = tracer.header(process.version);
    header.session.source_files[0].sha256 = createHash("sha256").update(source).digest("hex");
    header.session.guards_active = guardsApplied();
    write(header);
    tracer.emit("run_start", {});
    tracer.note("warn", `Could not parse the program: ${error.message}`);
    tracer.finish("error", 1);
    return 1;
  }

  const header = tracer.header(process.version);
  header.session.source_files[0].sha256 = createHash("sha256").update(source).digest("hex");
  header.session.source_files[0].line_count = tracer.lineCount;
  header.session.guards_active = guardsApplied();
  write(header);

  // The program's output belongs to the trace, not to the stream carrying the trace.
  const realLog = console.log;
  console.log = (...parts) => tracer.output("stdout", parts.map(render).join(" ") + "\n");
  console.error = (...parts) => tracer.output("stderr", parts.map(render).join(" ") + "\n");

  // `prompt()` is how JavaScript asks a question. It exists in browsers and not in Node, so providing it
  // here gives traced programs the language's own idiom rather than an invented one — and it returns a
  // string or null exactly as the browser's does, so a program written for the web behaves the same.
  const reader = createLineReader(0, { deadlineMs: args.wallMs });
  globalThis.prompt = (message = "") => tracer.ask(String(message ?? ""), reader.readLine);

  globalThis[RUNTIME] = tracer;
  tracer.start();
  let moduleFrame;
  if (args.unknown.length > 0) {
    tracer.note("warn", `Ignored unrecognised options: ${args.unknown.join(" ")}`);
  }
  moduleFrame = tracer.enter("<module>", 1, {});

  let status = "ok";
  let exitCode = 0;
  try {
    // A data: URL, so the instrumented text runs as a real module with import support and without ever
    // being written to disk.
    const url = `data:text/javascript;base64,${Buffer.from(instrumented.code).toString("base64")}`;
    await import(url);
    // The module body finishing is not the program finishing.
    //
    // A program whose last statement is `main()` returns a promise and leaves its real work queued. Closing the
    // trace here reported `ok` while the output had not been produced yet — the answer the program existed to
    // print never appeared in the trace at all.
    await settled(tracer, args.wallMs);
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      status = tracer.stopReason ?? "step_limit";
    } else {
      status = "error";
      exitCode = 1;
      tracer.stopped = false;
      tracer.uncaught(error);
    }
  } finally {
    console.log = realLog;
  }

  // The run is over however it ended, and what remains is closing the trace: pop the module frame and say
  // how it finished. A budget stop leaves emission switched off, so it has to be switched back on first or
  // the trace ends with a frame that was pushed and never popped.
  tracer.seal();
  tracer.leave(moduleFrame);
  // Anything the program left parked — a promise nothing resolved, a call still awaiting — closed so the trace
  // does not end with frames it opened and never accounted for.
  tracer.closeAbandoned();
  tracer.finish(status, exitCode);
  return status === "ok" || status === "step_limit" || status === "timeout" ? 0 : 1;
}

/**
 * Wait until the program has no work left, or until its time is up.
 *
 * `beforeExit` is the event loop saying it has nothing further to do, which is the only accurate answer to "has
 * this program finished". Polling for it would be guesswork, and finishing as soon as the module body returns is
 * wrong for any program that does its work in a promise.
 *
 * The deadline is `unref`'d deliberately: a referenced timer is itself work, so it would keep the loop alive and
 * `beforeExit` would never fire. Unreferenced, it still goes off on time — it simply does not hold the door open.
 */
function settled(tracer, wallMs) {
  return new Promise((resolve) => {
    const remaining = Math.max(0, wallMs - tracer.elapsedMs());
    const deadline = setTimeout(() => {
      tracer.note("warn", "The program still had work queued when its time ran out.");
      resolve();
    }, remaining);
    deadline.unref();
    process.once("beforeExit", () => {
      clearTimeout(deadline);
      resolve();
    });
  });
}

/** How a value appears in captured output. `console.log` does not stringify the way `String` does. */
function render(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * What is actually protecting this run.
 *
 * Node's permission model is the real mechanism, and it is applied by the *caller* through command-line
 * flags — it cannot be turned on from inside the process. So this reports what was granted rather than
 * claiming to have arranged it, and says so plainly when nothing was.
 *
 * Only the scopes node actually has are reported. An earlier version asked `permission.has("net")` and
 * announced "network refused" when it came back false — but there is no `net` scope in the permission
 * model, so the answer was always false and the claim was always untrue. A guard that is advertised and
 * not enforced is worse than one that is absent: it is the reason someone would stop being careful.
 */
const PERMISSION_SCOPES = [
  ["fs.write", "writes refused (node permission model)"],
  ["child", "child processes refused"],
  ["worker", "worker threads refused"],
  ["addon", "native addons refused"],
];

function guardsApplied() {
  const permission = process.permission;
  if (!permission) {
    return ["no sandbox: node was started without --permission"];
  }
  const guards = [];
  for (const [scope, description] of PERMISSION_SCOPES) {
    if (!permission.has(scope)) guards.push(description);
  }
  if (guards.length === 0) {
    return ["node permission model active, but nothing is restricted"];
  }
  // Said out loud, because the list above reads like a complete account of what cannot happen and it is
  // not one. Node has no network permission scope, so nothing here stops a program opening a socket.
  guards.push("network NOT restricted: node has no permission scope for it");
  return guards;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

export { main };
