/**
 * Turning trace values into text a human reads.
 *
 * Language-aware on purpose. A Python user who sees `null` or `true` where their source says `None`
 * and `True` has been handed a small lie about their own program, and small lies are exactly what a
 * teaching tool cannot afford. The trace carries language-neutral values; presentation is where the
 * dialect comes back.
 */

import type { Language, ObjKind, Shape, Value } from "@flow-view/trace-schema";
import { isAddr, isPrim, isRef, isUnavailable } from "@flow-view/trace-schema";
import type { ObjectLive, TraceState } from "@flow-view/trace-store";

export interface FormatOptions {
  readonly language: Language;
  /** Resolve references to a short summary of the target. */
  readonly state?: TraceState;
  /** Characters after which a rendered value is elided. */
  readonly maxLength?: number;
}

const NULL_LITERAL: Record<Language, string> = {
  python: "None",
  javascript: "null",
  c: "NULL",
  cpp: "nullptr",
  java: "null",
};

const BOOL_LITERAL: Record<Language, readonly [string, string]> = {
  python: ["False", "True"],
  javascript: ["false", "true"],
  c: ["0", "1"],
  cpp: ["false", "true"],
  java: ["false", "true"],
};

/** Render a primitive the way the source language writes it. */
export function formatPrimitive(value: unknown, language: Language): string {
  if (value === null) return NULL_LITERAL[language];
  if (typeof value === "boolean") return BOOL_LITERAL[language][value ? 1 : 0];
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
    return String(value);
  }
  return String(value);
}

/** A one-line label for a heap object, e.g. `list[4]` or `Node(key=8)`. */
export function summarizeObject(obj: ObjectLive): string {
  if (obj.summary) return obj.summary;
  const count = obj.order.length;
  switch (obj.kind) {
    case "list":
    case "array":
    case "tuple":
      return `${obj.typeName}[${count}]`;
    case "map":
      return `${obj.typeName}{${count}}`;
    case "set":
      return `${obj.typeName}{${count}}`;
    case "string":
    case "bytes":
      return obj.typeName;
    default:
      return obj.typeName;
  }
}

/**
 * Render a value for display.
 *
 * References render as the target's summary rather than a bare id: `#3` tells a learner nothing,
 * `list[4]` tells them what they are looking at. The id is kept alongside so the heap view can be
 * cross-referenced.
 */
export function formatValue(value: Value | undefined, options: FormatOptions): string {
  if (value === undefined) return "—";
  const { language, state, maxLength = 80 } = options;

  if (isPrim(value)) {
    const text = value.bigint ? String(value.prim) : formatPrimitive(value.prim, language);
    if (value.truncated !== undefined) {
      return `${clip(text, maxLength)} … (${value.truncated} chars)`;
    }
    return clip(text, maxLength);
  }

  if (isRef(value)) {
    const target = state?.objects.get(value.ref);
    if (!target) return `#${value.ref}`;
    const freed = target.freed ? " (freed)" : "";
    return `${summarizeObject(target)}${freed}`;
  }

  if (isAddr(value)) {
    return value.dangling ? `${value.addr} (dangling)` : value.addr;
  }

  if (isUnavailable(value)) return `unavailable: ${value.unavailable}`;
  return "—";
}

/** Declared or runtime type of a value, for the type column. */
export function typeOfValue(value: Value | undefined, options: FormatOptions): string {
  if (value === undefined) return "";
  if (isPrim(value)) {
    if (value.prim === null) return options.language === "python" ? "NoneType" : "null";
    if (typeof value.prim === "boolean") return "bool";
    if (typeof value.prim === "string") return value.bigint ? "int" : "str";
    return Number.isInteger(value.prim) ? "int" : "float";
  }
  if (isRef(value)) return options.state?.objects.get(value.ref)?.typeName ?? "object";
  if (isAddr(value)) return value.type;
  if (isUnavailable(value)) return "";
  return "";
}

/** Human-readable name for an inferred shape. */
export function shapeLabel(shape: Shape | undefined): string {
  if (!shape) return "";
  const labels: Partial<Record<Shape, string>> = {
    linked_list: "linked list",
    doubly_linked_list: "doubly linked list",
    circular_linked_list: "circular linked list",
    binary_tree: "binary tree",
    bst: "binary search tree",
    nary_tree: "n-ary tree",
    directed_graph: "directed graph",
    undirected_graph: "undirected graph",
  };
  return labels[shape] ?? shape.replace(/_/g, " ");
}

/** Short label for an object kind, used as a badge. */
export function kindLabel(kind: ObjKind): string {
  return kind.replace(/_/g, " ");
}

/** Truncate with an ellipsis, without cutting mid-escape. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Format a duration for the timeline and status bar. */
export function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
