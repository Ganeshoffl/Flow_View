/**
 * Measuring the object graph.
 *
 * Classification needs facts, and this is where they come from: how objects of the same type refer to
 * each other, whether those references form a cycle, whether anything is reachable by two paths,
 * whether nested rows are the same length.
 *
 * Nothing here decides what a structure *is*. Keeping measurement separate from judgement means the
 * evidence a classification rests on can be reported to the user, which is what makes a wrong guess
 * explainable instead of mysterious.
 */

import type { ObjectLive, TraceState } from "@flow-view/trace-store";
import { isRef } from "@flow-view/trace-schema";

export interface Edge {
  readonly from: number;
  readonly to: number;
  /** Slot the reference lives in: a field name, or an index for a sequence. */
  readonly key: string;
}

/** A group of same-type objects joined by references between them. */
export interface Component {
  readonly typeName: string;
  readonly members: number[];
  readonly edges: Edge[];
  /** Members with no incoming edge from inside the component. */
  readonly roots: number[];
  /** Field names that carry references to the same type, in first-seen order. */
  readonly linkFields: string[];
}

export interface Measurements {
  /** Highest number of same-type references any one member holds. */
  readonly maxOutDegree: number;
  /** True when following references can return to somewhere already visited. */
  readonly hasCycle: boolean;
  /** True when a cycle returns to the component's root specifically. */
  readonly cycleReturnsToRoot: boolean;
  /** True when some member is reachable by two different paths — so it is not a tree. */
  readonly hasSharedNode: boolean;
  /** Members that hold no same-type references at all. */
  readonly leafCount: number;
  readonly memberCount: number;
  readonly edgeCount: number;
  /** True when every edge has a matching edge in the opposite direction. */
  readonly isSymmetric: boolean;
  /** Longest path from a root, in edges. */
  readonly depth: number;
}

/** References from one object to another of the same type. */
export function sameTypeEdges(state: TraceState, obj: ObjectLive): Edge[] {
  const edges: Edge[] = [];
  for (const [key, value] of obj.slots) {
    if (!isRef(value)) continue;
    const target = state.objects.get(value.ref);
    if (target && target.typeName === obj.typeName) {
      edges.push({ from: obj.obj, to: target.obj, key });
    }
  }
  return edges;
}

/**
 * Group objects into components of the same type joined by references.
 *
 * Only live objects participate. A freed object is still in state — it is kept so `obj_free` can be
 * undone — but including it would draw a structure the program no longer has.
 */
export function findComponents(state: TraceState): Component[] {
  const byType = new Map<string, ObjectLive[]>();
  for (const obj of state.objects.values()) {
    if (obj.freed) continue;
    if (!isLinkable(obj)) continue;
    byType.set(obj.typeName, [...(byType.get(obj.typeName) ?? []), obj]);
  }

  const components: Component[] = [];

  for (const [typeName, objects] of byType) {
    const ids = new Set(objects.map((o) => o.obj));
    const allEdges = objects.flatMap((obj) => sameTypeEdges(state, obj));
    if (allEdges.length === 0) continue;

    // Undirected reachability decides membership: two nodes belong together if either points at the
    // other, regardless of direction.
    const neighbours = new Map<number, Set<number>>();
    const link = (a: number, b: number) => {
      neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
      neighbours.set(b, (neighbours.get(b) ?? new Set()).add(a));
    };
    for (const edge of allEdges) link(edge.from, edge.to);

    const unassigned = new Set([...neighbours.keys()].filter((id) => ids.has(id)));
    while (unassigned.size > 0) {
      const start = unassigned.values().next().value as number;
      const members: number[] = [];
      const queue = [start];
      unassigned.delete(start);
      while (queue.length > 0) {
        const current = queue.pop() as number;
        members.push(current);
        for (const next of neighbours.get(current) ?? []) {
          if (unassigned.delete(next)) queue.push(next);
        }
      }

      const memberSet = new Set(members);
      const edges = allEdges.filter((e) => memberSet.has(e.from) && memberSet.has(e.to));
      const hasIncoming = new Set(edges.map((e) => e.to));
      const linkFields: string[] = [];
      for (const edge of edges) {
        if (!linkFields.includes(edge.key)) linkFields.push(edge.key);
      }

      components.push({
        typeName,
        members: members.sort((a, b) => a - b),
        edges,
        roots: members.filter((id) => !hasIncoming.has(id)).sort((a, b) => a - b),
        linkFields: linkFields.sort(),
      });
    }
  }

  return components;
}

/** Whether an object can take part in a linked structure. */
function isLinkable(obj: ObjectLive): boolean {
  return obj.kind === "instance" || obj.kind === "struct" || obj.kind === "object";
}

export function measure(component: Component): Measurements {
  const outgoing = new Map<number, Edge[]>();
  const incoming = new Map<number, number>();
  for (const edge of component.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  const maxOutDegree = Math.max(
    0,
    ...component.members.map((id) => (outgoing.get(id) ?? []).length),
  );
  const leafCount = component.members.filter((id) => (outgoing.get(id) ?? []).length === 0).length;
  const hasSharedNode = component.members.some((id) => (incoming.get(id) ?? 0) > 1);

  // Cycle detection by three-colour depth-first search: every node and edge is examined once.
  //
  // This was originally written to walk every path from every start, keeping the current path in a set
  // so a repeat meant a cycle. That is correct and catastrophically slow: the number of simple paths
  // through a dense graph grows factorially, and a 120-node graph with three edges per node did not
  // finish in fifteen minutes. Cycles are a property of edges, not of paths, and cost O(V+E) to find.
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<number, number>();
  for (const id of component.members) colour.set(id, WHITE);

  let hasCycle = false;
  let cycleReturnsToRoot = false;
  const rootSet = new Set(component.roots);

  for (const start of component.members) {
    if (colour.get(start) !== WHITE) continue;
    // Explicit stack rather than recursion: a half-million-node chain would overflow the call stack,
    // and the traversal is not naturally recursive anyway.
    const stack: { id: number; edgeIndex: number }[] = [{ id: start, edgeIndex: 0 }];
    colour.set(start, GREY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edges = outgoing.get(frame.id) ?? [];
      if (frame.edgeIndex >= edges.length) {
        colour.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const edge = edges[frame.edgeIndex++]!;
      const target = colour.get(edge.to);
      if (target === GREY) {
        // A back edge: the target is still on the current path.
        hasCycle = true;
        if (rootSet.has(edge.to) || edge.to === start) cycleReturnsToRoot = true;
        continue;
      }
      if (target === WHITE) {
        colour.set(edge.to, GREY);
        stack.push({ id: edge.to, edgeIndex: 0 });
      }
    }
  }

  // With no root, every member has something pointing at it, which for a finite component means a
  // cycle that comes back round.
  if (component.roots.length === 0 && component.members.length > 0) {
    hasCycle = true;
    cycleReturnsToRoot = true;
  }

  // Depth by breadth-first distance from the roots. Longest-path is intractable in general and is not
  // what a layout needs; how far from the root a node sits is.
  let depth = 0;
  const distance = new Map<number, number>();
  const queue: number[] = [];
  for (const root of component.roots.length > 0 ? component.roots : component.members.slice(0, 1)) {
    distance.set(root, 0);
    queue.push(root);
  }
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    const here = distance.get(id) ?? 0;
    depth = Math.max(depth, here);
    for (const edge of outgoing.get(id) ?? []) {
      if (distance.has(edge.to)) continue;
      distance.set(edge.to, here + 1);
      queue.push(edge.to);
    }
  }

  const edgeKey = (edge: Edge) => `${edge.from}->${edge.to}`;
  const present = new Set(component.edges.map(edgeKey));
  const isSymmetric =
    component.edges.length > 0 &&
    component.edges.every((edge) => present.has(`${edge.to}->${edge.from}`));

  return {
    maxOutDegree,
    hasCycle,
    cycleReturnsToRoot,
    hasSharedNode,
    leafCount,
    memberCount: component.members.length,
    edgeCount: component.edges.length,
    isSymmetric,
    depth,
  };
}

// ---------------------------------------------------------------------------
// sequences
// ---------------------------------------------------------------------------

export interface SequenceShape {
  /** True when every element is a sequence of the same length, with at least two rows. */
  readonly isMatrix: boolean;
  readonly rows: number;
  readonly columns: number;
}

export function measureSequence(state: TraceState, obj: ObjectLive): SequenceShape {
  const elements = obj.order
    .map((key) => obj.slots.get(key))
    .filter((value): value is NonNullable<typeof value> => value !== undefined);

  if (elements.length < 2) return { isMatrix: false, rows: elements.length, columns: 0 };

  const lengths: number[] = [];
  for (const value of elements) {
    if (!isRef(value)) return { isMatrix: false, rows: elements.length, columns: 0 };
    const child = state.objects.get(value.ref);
    if (!child || (child.kind !== "list" && child.kind !== "array" && child.kind !== "tuple")) {
      return { isMatrix: false, rows: elements.length, columns: 0 };
    }
    lengths.push(child.order.length);
  }

  const first = lengths[0] ?? 0;
  const uniform = first > 0 && lengths.every((length) => length === first);
  return { isMatrix: uniform, rows: elements.length, columns: uniform ? first : 0 };
}

/**
 * Whether a map's values are collections of its own keys — an adjacency list.
 *
 * This is how a graph is usually written when it is not written with node objects, and recognising it
 * is the difference between drawing a graph and drawing a dictionary of unrelated lists.
 */
export function looksLikeAdjacency(state: TraceState, obj: ObjectLive): boolean {
  if (obj.kind !== "map" || obj.slots.size < 2) return false;
  const keys = new Set(obj.slots.keys());
  let matched = 0;
  let total = 0;

  for (const value of obj.slots.values()) {
    if (!isRef(value)) return false;
    const child = state.objects.get(value.ref);
    if (!child) return false;
    if (child.kind !== "list" && child.kind !== "array" && child.kind !== "set") return false;
    for (const element of child.slots.values()) {
      total++;
      if ("prim" in element && typeof element.prim === "string" && keys.has(element.prim)) {
        matched++;
      }
    }
  }

  // Most entries naming other keys, rather than all of them: a graph under construction has
  // neighbours that do not exist yet.
  return total > 0 && matched / total >= 0.6;
}

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

/**
 * Whether a two-child structure holds the binary-search-tree ordering.
 *
 * Checked over the whole tree rather than between parents and children, because the local check
 * passes for structures that are not search trees. Every value in a left subtree must be smaller than
 * the node, not merely the immediate left child.
 */
export function holdsSearchOrdering(
  state: TraceState,
  component: Component,
  leftField: string,
  rightField: string,
  keyField: string,
): boolean {
  const root = component.roots[0];
  if (root === undefined) return false;

  const keyOf = (id: number): number | null => {
    const value = state.objects.get(id)?.slots.get(keyField);
    if (!value || !("prim" in value)) return null;
    return typeof value.prim === "number" ? value.prim : null;
  };

  const childOf = (id: number, field: string): number | null => {
    const value = state.objects.get(id)?.slots.get(field);
    return value && isRef(value) ? value.ref : null;
  };

  const check = (id: number | null, low: number, high: number, seen: Set<number>): boolean => {
    if (id === null) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const key = keyOf(id);
    if (key === null || key <= low || key >= high) return false;
    return (
      check(childOf(id, leftField), low, key, seen) &&
      check(childOf(id, rightField), key, high, seen)
    );
  };

  return check(root, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, new Set());
}

/** Fields holding a comparable primitive, as candidate sort keys. */
export function comparableFields(state: TraceState, component: Component): string[] {
  const root = component.roots[0] ?? component.members[0];
  if (root === undefined) return [];
  const obj = state.objects.get(root);
  if (!obj) return [];
  const found: string[] = [];
  for (const [key, value] of obj.slots) {
    if ("prim" in value && typeof value.prim === "number") found.push(key);
  }
  return found;
}
