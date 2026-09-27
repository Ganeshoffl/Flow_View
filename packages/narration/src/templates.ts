/**
 * Turning trace events into sentences.
 *
 * Deterministic templates, no model, no network. Everything a sentence needs is already in the trace:
 * a `var_set` carries both the old and new value, a `branch` carries the condition as the user wrote it
 * and which way control went, a `frame_push` carries the arguments and the recursion depth.
 *
 * Three rules govern the prose.
 *
 * **Say what happened, not what the event is called.** "`total` changed from 6 to 10" tells a learner
 * something; "var_set total" tells them the tool's vocabulary.
 *
 * **Never state anything the trace does not support.** A branch outcome is reported because it was
 * observed. A condition's *value* is not, because Python cannot supply it and guessing would mean
 * re-running the user's expression.
 *
 * **Use the reader's language.** A Python programmer wrote `None`, not `null`, and a sentence that
 * says otherwise is describing a program they did not write.
 */

import type { Language, TraceEvent, Value } from "@flow-view/trace-schema";
import { isRef } from "@flow-view/trace-schema";
import type { TraceState } from "@flow-view/trace-store";

import { type Construction, type Swap, detectConstruction, detectSwap } from "./steps.js";

export interface NarrationContext {
  readonly state: TraceState;
  readonly language: Language;
  /** Renders a value the way the rest of the UI does. */
  readonly format: (value: Value | undefined) => string;
}

export interface Sentence {
  readonly text: string;
  /** What kind of thing happened, for styling and filtering. */
  readonly kind:
    | "assignment"
    | "branch"
    | "loop"
    | "call"
    | "return"
    | "mutation"
    | "allocation"
    | "output"
    | "input"
    | "error"
    | "control"
    | "lifecycle"
    | "note";
}

const code = (text: string): string => `\`${text}\``;

/** A short description of what a reference points at, for use inside a sentence. */
function describeTarget(value: Value | undefined, context: NarrationContext): string {
  if (!value || !isRef(value)) return context.format(value);
  const target = context.state.objects.get(value.ref);
  if (!target) return context.format(value);
  const count = target.order.length;
  switch (target.kind) {
    case "list":
    case "array":
      return count === 1 ? "a list of 1 element" : `a list of ${count} elements`;
    case "map":
      return `a dictionary of ${count} entries`;
    case "set":
      return `a set of ${count} elements`;
    case "tuple":
      return `a tuple of ${count} elements`;
    case "instance":
    case "struct":
      return `a ${target.typeName}`;
    case "function":
      return `the function ${code(target.summary?.replace(/\(\)$/, "") ?? target.typeName)}`;
    case "class":
      return `the class ${code(target.typeName)}`;
    default:
      return context.format(value);
  }
}

// ---------------------------------------------------------------------------
// one event at a time
// ---------------------------------------------------------------------------

function narrateEvent(event: TraceEvent, context: NarrationContext): Sentence | undefined {
  const { format } = context;

  switch (event.t) {
    case "var_set": {
      const name = code(event.name);
      const to = isRef(event.value) ? describeTarget(event.value, context) : format(event.value);
      if (event.prev === undefined) {
        return { kind: "assignment", text: `${name} is set to ${to}.` };
      }
      const from = isRef(event.prev) ? describeTarget(event.prev, context) : format(event.prev);
      if (from === to) {
        // Same rendering, different object: worth saying, because the heap view will show two boxes.
        return { kind: "assignment", text: `${name} is replaced by another ${to}.` };
      }
      return { kind: "assignment", text: `${name} changes from ${from} to ${to}.` };
    }

    case "var_del":
      return { kind: "assignment", text: `${code(event.name)} goes out of scope.` };

    case "branch": {
      const condition = code(event.expr);
      const taken = event.outcome === "taken";
      switch (event.kind) {
        case "while":
          return {
            kind: "branch",
            text: taken
              ? `${condition} still holds, so the loop runs again.`
              : `${condition} no longer holds, so the loop ends.`,
          };
        case "for":
          return {
            kind: "branch",
            text: taken
              ? `There is another value in ${condition}, so the loop body runs.`
              : `${condition} has no values left, so the loop ends.`,
          };
        case "elif":
          return {
            kind: "branch",
            text: taken
              ? `${condition} is true, so this branch runs.`
              : `${condition} is false, so the next case is tried.`,
          };
        case "else":
          return { kind: "branch", text: `None of the earlier conditions held, so this branch runs.` };
        default:
          return {
            kind: "branch",
            text: taken
              ? `${condition} is true, so the body runs.`
              : `${condition} is false, so the body is skipped.`,
          };
      }
    }

    case "loop_enter":
      return { kind: "loop", text: `A loop starts at line ${event.line_start}.` };

    case "loop_iter":
      // Counted from one, because "iteration 0" is a programmer's convention and this sentence is for
      // someone who may not have it yet. The variable's own value still reads as the program wrote it.
      return { kind: "loop", text: `Iteration ${event.i + 1} begins.` };

    case "loop_exit": {
      const times = event.iterations === 1 ? "once" : `${event.iterations} times`;
      const why = {
        condition: "its condition stopped holding",
        break: "a break was reached",
        return: "the function returned",
        exception: "an error interrupted it",
      }[event.reason];
      return { kind: "loop", text: `The loop ran ${times} and ended because ${why}.` };
    }

    case "jump":
      return {
        kind: "control",
        text:
          event.kind === "break"
            ? `${code("break")} leaves the loop immediately.`
            : event.kind === "continue"
              ? `${code("continue")} skips the rest of this iteration.`
              : `Control jumps to line ${event.target_line ?? "?"}.`,
      };

    case "frame_push": {
      const name = code(event.func);
      const args =
        event.args.length === 0
          ? "no arguments"
          : event.args
              .map((arg) => `${code(arg.name)} = ${isRef(arg.value) ? describeTarget(arg.value, context) : format(arg.value)}`)
              .join(", ");

      if (event.kind === "library") {
        return { kind: "call", text: `${name} is called with ${args}. It runs as a single step.` };
      }
      if (event.recursion_depth > 0) {
        return {
          kind: "call",
          text: `${name} calls itself with ${args}. This is ${ordinal(event.recursion_depth + 1)} time in, ${event.recursion_depth} still waiting to finish.`,
        };
      }
      if (event.func === "<module>") {
        return { kind: "lifecycle", text: "The program begins." };
      }
      return { kind: "call", text: `${name} is called with ${args}.` };
    }

    case "frame_pop": {
      if (event.reason === "exception") {
        return { kind: "error", text: `The call is abandoned because of an error.` };
      }
      if (event.return_value === undefined) {
        return { kind: "return", text: "The call ends." };
      }
      const value = isRef(event.return_value)
        ? describeTarget(event.return_value, context)
        : format(event.return_value);
      return { kind: "return", text: `The call returns ${value}.` };
    }

    case "obj_new":
      return {
        kind: "allocation",
        text: `A new ${event.type_name} is created${
          event.length ? ` with ${event.length} elements` : ""
        }.`,
      };

    case "obj_set": {
      const where = describeSlot(event.obj, String(event.key), context);
      const to = isRef(event.value) ? describeTarget(event.value, context) : format(event.value);
      switch (event.op) {
        case "append":
          return { kind: "mutation", text: `${to} is added to the end of ${describeOwner(event.obj, context)}.` };
        case "insert":
          return { kind: "mutation", text: `${to} is inserted at position ${event.key}.` };
        case "delete":
          return { kind: "mutation", text: `${where} is removed.` };
        default: {
          if (event.prev === undefined) {
            return { kind: "mutation", text: `${where} is set to ${to}.` };
          }
          const from = isRef(event.prev) ? describeTarget(event.prev, context) : format(event.prev);
          return { kind: "mutation", text: `${where} changes from ${from} to ${to}.` };
        }
      }
    }

    case "obj_resize":
      return {
        kind: "mutation",
        text:
          event.length === 0
            ? `${describeOwner(event.obj, context)} is emptied.`
            : `${describeOwner(event.obj, context)} now holds ${event.length} elements.`,
      };

    case "obj_free":
      return { kind: "mutation", text: `The memory for ${describeOwner(event.obj, context)} is released.` };

    case "stdout":
      return event.text.trim()
        ? { kind: "output", text: `The program prints ${code(event.text.replace(/\n$/, ""))}.` }
        : undefined;

    case "stderr":
      return event.text.trim()
        ? { kind: "error", text: `The program writes ${code(event.text.trim().split("\n")[0] ?? "")} to its error output.` }
        : undefined;

    case "stdin_request":
      return {
        kind: "input",
        text: event.prompt
          ? `The program waits for input, asking ${code(event.prompt.trim())}.`
          : "The program waits for input.",
      };

    case "stdin_response":
      return { kind: "input", text: `${code(event.text)} is supplied as the input.` };

    case "exception_raise":
      return {
        kind: "error",
        text: `A ${event.type} is raised: ${event.message}.`,
      };

    case "exception_catch":
      return { kind: "error", text: `The error is caught here, and the program carries on.` };

    case "exception_uncaught":
      return {
        kind: "error",
        text: `Nothing catches the ${event.type}, so the program stops.`,
      };

    case "collapse":
      return {
        kind: "loop",
        text: `${event.iterations} iterations are folded together here. Expand the region to step through them.`,
      };

    case "note":
      return { kind: "note", text: event.text };

    case "run_end": {
      const explanation: Record<string, string> = {
        ok: "The program finished normally.",
        error: "The program stopped because of an error.",
        timeout: "The program was stopped for taking too long.",
        step_limit: `The program was stopped after ${event.steps} steps.`,
        memory_limit: "The program was stopped for using too much memory.",
        killed: "The program was stopped.",
      };
      return { kind: "lifecycle", text: explanation[event.status] ?? "The program stopped." };
    }

    // Deliberately silent. A line event on its own says only "we are here", which the highlighted
    // line already says better, and a sentence per line would drown the ones that matter.
    case "step_line":
    case "run_start":
    case "metric":
    case "structure_hint":
    case "snapshot":
    case "mem_alloc":
    case "mem_free":
    case "ptr_set":
      return undefined;

    default:
      return undefined;
  }
}

function describeOwner(objId: number, context: NarrationContext): string {
  const obj = context.state.objects.get(objId);
  if (!obj) return "the object";
  const name = nameFor(objId, context);
  if (name) return code(name);
  return `the ${obj.typeName}`;
}

function describeSlot(objId: number, key: string, context: NarrationContext): string {
  const obj = context.state.objects.get(objId);
  const name = nameFor(objId, context);
  const owner = name ? code(name) : obj ? `the ${obj.typeName}` : "the object";

  // Positional keys read as positions, named keys as attributes. The fallback has to be a phrase that
  // works at the start of a sentence too — "the object[0] is set to 5" was neither English nor
  // capitalised.
  if (!obj) return `Slot ${code(key)} of ${owner}`;
  if (obj.kind === "list" || obj.kind === "array" || obj.kind === "tuple") {
    return `Position ${key} of ${owner}`;
  }
  if (obj.kind === "map") return `The entry ${code(key)} of ${owner}`;
  if (name) return code(`${name}.${key}`);
  return `The ${code(key)} of ${owner}`;
}

/**
 * A variable currently pointing at an object, so a sentence can use the user's own name for it.
 *
 * "`values[2]` changes" is worth far more than "position 2 of the list changes", and the binding is
 * already in state.
 */
function nameFor(objId: number, context: NarrationContext): string | undefined {
  for (const frameId of [...context.state.frameOrder].reverse()) {
    const frame = context.state.frames.get(frameId);
    if (!frame) continue;
    for (const [name, value] of frame.bindings) {
      if (isRef(value) && value.ref === objId) return name;
    }
  }
  return undefined;
}

function ordinal(n: number): string {
  const names = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
  return names[n - 1] ?? `${n}th`;
}

// ---------------------------------------------------------------------------
// a whole step
// ---------------------------------------------------------------------------

/**
 * Sentences for one step.
 *
 * Patterns are recognised before individual events, so a swap reads as a swap rather than as two
 * unrelated writes that happen to undo each other.
 */
export function narrateStep(
  events: readonly TraceEvent[],
  context: NarrationContext,
): Sentence[] {
  const sentences: Sentence[] = [];

  const consumed = new Set<TraceEvent>();

  const swap = detectSwap(events);
  if (swap) {
    sentences.push(swapSentence(swap, context));
    for (const event of events) {
      if (event.t === "obj_set" && event.obj === swap.obj) consumed.add(event);
    }
  }

  const built = swap ? undefined : detectConstruction(events);
  if (built) {
    sentences.push(constructionSentence(built, context));
    for (const event of events) {
      if (event.t === "obj_new" && event.obj === built.obj) consumed.add(event);
      if (event.t === "obj_set" && event.obj === built.obj && event.prev === undefined) {
        consumed.add(event);
      }
    }
  }

  for (const event of events) {
    if (consumed.has(event)) continue;
    const sentence = narrateEvent(event, context);
    if (sentence) sentences.push({ ...sentence, text: asSentence(sentence.text) });
  }

  return sentences;
}

/**
 * Make sure a fragment reads as a sentence.
 *
 * A template that begins with a variable name or a keyword starts with a backtick, which is correct and
 * should be left alone. Anything beginning with a lowercase letter is a slip.
 */
function asSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const first = trimmed[0]!;
  const capitalised = /[a-z]/.test(first) ? first.toUpperCase() + trimmed.slice(1) : trimmed;
  return capitalised.endsWith(".") ? capitalised : `${capitalised}.`;
}

function constructionSentence(built: Construction, context: NarrationContext): Sentence {
  const obj = context.state.objects.get(built.obj);
  const typeName = obj?.typeName ?? "object";
  const shown = built.values.slice(0, 6);

  const parts = shown.map((event) => {
    if (event.t !== "obj_set") return "";
    const rendered = isRef(event.value)
      ? describeTarget(event.value, context)
      : context.format(event.value);
    // A keyed container reads as pairs; a sequence reads as a list of values.
    const positional = obj?.kind === "list" || obj?.kind === "array" || obj?.kind === "tuple";
    return positional ? rendered : `${code(String(event.key))} = ${rendered}`;
  });

  const more = built.values.length > shown.length ? `, and ${built.values.length - shown.length} more` : "";
  const contents = parts.filter(Boolean).join(", ");

  return {
    kind: "allocation",
    text: contents
      ? `A new ${typeName} is created holding ${contents}${more}.`
      : `A new ${typeName} is created.`,
  };
}

function swapSentence(swap: Swap, context: NarrationContext): Sentence {
  const owner = describeOwner(swap.obj, context);
  return {
    kind: "mutation",
    text: `Positions ${swap.left} and ${swap.right} of ${owner} are swapped.`,
  };
}
