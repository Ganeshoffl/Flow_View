/**
 * Deciding what a structure is.
 *
 * Every rule here returns its shape **and the evidence for it**, because an inference the user cannot
 * interrogate is worse than none: when the picture looks wrong they need to see why it was drawn that
 * way, and correct it.
 *
 * Two principles run through all of it.
 *
 * **Measured facts beat suggestive names.** A class with `left` and `right` fields whose instances
 * contain a cycle is a graph. The names say tree; the object graph says otherwise, and the object
 * graph is what the program actually built.
 *
 * **Uncertainty is reported, never hidden.** An unrecognised structure is `unknown`, which renders as
 * a plain object graph — correct, if unexciting. Guessing `binary_tree` because something has two
 * fields would produce a confident picture of a structure that is not there.
 */

import type { Confidence, Shape } from "@flow-view/trace-schema";
import type { ObjectLive, TraceState } from "@flow-view/trace-store";

import {
  type Component,
  type Measurements,
  comparableFields,
  holdsSearchOrdering,
  looksLikeAdjacency,
  measure,
  measureSequence,
} from "./measure.js";

export interface Inference {
  readonly obj: number;
  readonly shape: Shape;
  readonly confidence: Confidence;
  /** Why, in words the UI shows verbatim. */
  readonly evidence: readonly string[];
  /** True for the object a structure should be drawn from. */
  readonly root: boolean;
  /** Every object belonging to this structure, including the root. */
  readonly members: readonly number[];
  /** Fields carrying the structure's own links, for the layout to follow. */
  readonly linkFields: readonly string[];
}

/** Field names that conventionally mean a particular role. Treated as hints, never as proof. */
const FORWARD_NAMES = ["next", "succ", "nxt", "after", "tail"];
const BACKWARD_NAMES = ["prev", "previous", "pred", "before", "back"];
const LEFT_NAMES = ["left", "l", "lo", "lchild"];
const RIGHT_NAMES = ["right", "r", "hi", "rchild"];
const CHILDREN_NAMES = ["children", "kids", "nodes", "subs", "branches"];

const matches = (field: string, names: readonly string[]): boolean =>
  names.includes(field.toLowerCase());

const pick = (fields: readonly string[], names: readonly string[]): string | undefined =>
  fields.find((field) => matches(field, names));

// ---------------------------------------------------------------------------
// linked structures
// ---------------------------------------------------------------------------

/**
 * Edges that describe the structure's shape, excluding ones that point back the way you came.
 *
 * A backward link is not a second path through the data; it is the same path read in reverse. Counting
 * it made `a.next = b; b.prev = a` look like a two-node cycle, and a doubly linked list was being
 * reported as a circular one.
 */
function structuralEdges(component: Component): Component {
  const backward = component.linkFields.filter((field) => matches(field, BACKWARD_NAMES));
  if (backward.length === 0) return component;

  const edges = component.edges.filter((edge) => !backward.includes(edge.key));
  const hasIncoming = new Set(edges.map((edge) => edge.to));
  return {
    ...component,
    edges,
    roots: component.members.filter((id) => !hasIncoming.has(id)).sort((a, b) => a - b),
  };
}

export function classifyComponent(state: TraceState, component: Component): Inference[] {
  const facts = measure(structuralEdges(component));
  const { shape, confidence, evidence } = decideLinked(state, component, facts);

  const root = component.roots[0] ?? component.members[0];
  return component.members.map((id) => ({
    obj: id,
    shape,
    confidence,
    evidence,
    root: id === root,
    members: component.members,
    linkFields: component.linkFields,
  }));
}

function decideLinked(
  state: TraceState,
  component: Component,
  facts: Measurements,
): { shape: Shape; confidence: Confidence; evidence: string[] } {
  const { linkFields, typeName } = component;
  const evidence: string[] = [
    `${facts.memberCount} ${typeName} objects joined by ${describeFields(linkFields)}`,
  ];

  const forwardField = pick(linkFields, FORWARD_NAMES);

  // A cycle is decisive and is checked first: everything below assumes an acyclic structure.
  if (facts.hasCycle) {
    // A ring is only a ring when the links that form it are the kind that lead onward. Where
    // measurement alone is ambiguous — one reference per object, returning to the start — the field's
    // name is what settles it. `next` forming a loop is a circular list; `left` forming a loop is a
    // tree-shaped class that has been wired into a graph, which is what the user needs to be told.
    if (facts.maxOutDegree === 1 && facts.cycleReturnsToRoot && forwardField) {
      evidence.push(`each object refers to exactly one other, through ${forwardField}`);
      evidence.push("following those references returns to where it started");
      return { shape: "circular_linked_list", confidence: "high", evidence };
    }
    evidence.push("following the references can revisit an object, so this is not a tree");
    if (pick(linkFields, LEFT_NAMES) || pick(linkFields, RIGHT_NAMES)) {
      evidence.push("the field names suggest a tree, but the objects form a cycle");
    }
    // Symmetry only means "undirected" once there is enough of it to mean anything. Two objects
    // referring to each other are symmetric by arithmetic, not by design, and calling that an
    // undirected graph asserts more than was observed. Directed is true either way.
    if (facts.isSymmetric && facts.memberCount >= 3) {
      evidence.push("every reference is matched by one pointing back");
      return { shape: "undirected_graph", confidence: "medium", evidence };
    }
    return { shape: "directed_graph", confidence: "high", evidence };
  }

  if (facts.hasSharedNode) {
    evidence.push("at least one object is reachable by two different paths, so this is not a tree");
    return { shape: "directed_graph", confidence: "high", evidence };
  }

  const forward = forwardField;
  const backward = pick(linkFields, BACKWARD_NAMES);
  const left = pick(linkFields, LEFT_NAMES);
  const right = pick(linkFields, RIGHT_NAMES);
  const children = pick(linkFields, CHILDREN_NAMES);

  if (facts.maxOutDegree <= 1) {
    evidence.push("no object refers to more than one other");
    if (forward && backward && linkFields.length >= 2) {
      evidence.push(`${forward} leads on and ${backward} leads back`);
      return { shape: "doubly_linked_list", confidence: "high", evidence };
    }
    if (linkFields.length >= 2) {
      // Two link fields but only one used per object: still a chain, and naming it a doubly linked
      // list on the strength of the field count would be a guess.
      evidence.push(`two link fields exist (${linkFields.join(", ")}) but each object uses one`);
      return { shape: "linked_list", confidence: "medium", evidence };
    }
    return { shape: "linked_list", confidence: "high", evidence };
  }

  if (facts.maxOutDegree === 2 && left && right) {
    evidence.push(`two children per object, via ${left} and ${right}`);
    evidence.push("no object is reachable twice and there is no cycle, so it is a tree");

    for (const keyField of comparableFields(state, component)) {
      if (holdsSearchOrdering(state, component, left, right, keyField)) {
        evidence.push(
          `every ${keyField} to the left of an object is smaller and every one to the right is larger`,
        );
        return { shape: "bst", confidence: "high", evidence };
      }
    }
    evidence.push("the ordering of a search tree does not hold");
    return { shape: "binary_tree", confidence: "high", evidence };
  }

  if (facts.maxOutDegree === 2) {
    evidence.push("two children per object, through fields with no conventional names");
    return { shape: "binary_tree", confidence: "medium", evidence };
  }

  if (children || facts.maxOutDegree > 2) {
    evidence.push(`up to ${facts.maxOutDegree} children per object`);
    evidence.push("no object is reachable twice and there is no cycle, so it is a tree");
    return { shape: "nary_tree", confidence: children ? "high" : "medium", evidence };
  }

  evidence.push("the arrangement does not match a shape flow_view recognises");
  return { shape: "unknown", confidence: "low", evidence };
}

function describeFields(fields: readonly string[]): string {
  if (fields.length === 0) return "no fields";
  if (fields.length === 1) return `a ${fields[0]} field`;
  return `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`;
}

// ---------------------------------------------------------------------------
// containers
// ---------------------------------------------------------------------------

/** Access history for one object, used to tell a stack from a queue. */
export interface AccessPattern {
  readonly appends: number;
  readonly removalsAtEnd: number;
  readonly removalsAtStart: number;
  readonly insertsAtStart: number;
  readonly randomWrites: number;
}

export function classifyContainer(
  state: TraceState,
  obj: ObjectLive,
  access: AccessPattern | undefined,
): Inference | undefined {
  const base = {
    obj: obj.obj,
    root: true,
    members: [obj.obj] as readonly number[],
    linkFields: [] as readonly string[],
  };

  switch (obj.kind) {
    case "list":
    case "array": {
      const sequence = measureSequence(state, obj);
      if (sequence.isMatrix) {
        return {
          ...base,
          shape: "matrix",
          confidence: "high",
          evidence: [
            `${sequence.rows} rows, each holding ${sequence.columns} elements`,
            "every row is the same length, so it reads as a grid",
          ],
        };
      }

      // Access pattern separates a stack and a queue from a plain list. It needs history, so a list
      // only ever appended to stays an array — which is the honest answer, since nothing has yet
      // distinguished it.
      if (access && access.randomWrites === 0 && access.appends >= 2) {
        if (access.removalsAtEnd >= 1 && access.removalsAtStart === 0) {
          return {
            ...base,
            shape: "stack",
            confidence: "high",
            evidence: [
              `${access.appends} pushes and ${access.removalsAtEnd} pops, all at the same end`,
              "nothing is ever removed from the front",
            ],
          };
        }
        if (access.removalsAtStart >= 1 && access.removalsAtEnd === 0) {
          return {
            ...base,
            shape: "queue",
            confidence: "high",
            evidence: [
              `${access.appends} added at the back, ${access.removalsAtStart} taken from the front`,
            ],
          };
        }
        if (access.removalsAtStart >= 1 && access.removalsAtEnd >= 1) {
          return {
            ...base,
            shape: "deque",
            confidence: "medium",
            evidence: ["elements are added and removed at both ends"],
          };
        }
      }

      return {
        ...base,
        shape: "array",
        confidence: "high",
        evidence: [`${obj.order.length} elements in positional order`],
      };
    }

    case "map": {
      if (looksLikeAdjacency(state, obj)) {
        return {
          ...base,
          shape: "directed_graph",
          confidence: "medium",
          evidence: [
            "the values are collections of the map's own keys",
            "that is how an adjacency list is written",
          ],
        };
      }
      return {
        ...base,
        shape: "map",
        confidence: "high",
        evidence: [`${obj.slots.size} key-value pairs`],
      };
    }

    case "set":
      return {
        ...base,
        shape: "set",
        confidence: "high",
        evidence: [`${obj.slots.size} unique elements, in no particular order`],
      };

    case "tuple":
      return {
        ...base,
        shape: "tuple",
        confidence: "high",
        evidence: [`${obj.order.length} elements, fixed once created`],
      };

    case "string":
    case "bytes":
      return { ...base, shape: "string", confidence: "high", evidence: ["a sequence of characters"] };

    default:
      return undefined;
  }
}
