/**
 * Placing heap objects on a canvas.
 *
 * One layout per inferred shape, because a shape only helps if it changes the drawing: a linked list
 * laid out as a force-directed blob teaches nothing that a list of fields would not.
 *
 * Every layout is **pure and deterministic**. Given the same objects it returns the same coordinates,
 * which matters for two reasons. Positions can be compared between steps to animate movement rather
 * than redrawing from scratch, so an insertion reads as a node *arriving*. And a diagram that
 * rearranges itself when nothing changed would make the user doubt what they are seeing.
 */

import type { Shape, Value } from "@flow-view/trace-schema";
import { isRef } from "@flow-view/trace-schema";
import type { Inference } from "@flow-view/inference";
import type { ObjectLive, TraceState } from "@flow-view/trace-store";

import { formatValue, summarizeObject } from "./format.js";

export interface Cell {
  readonly key: string;
  readonly text: string;
  /** Set when the cell holds a reference, so an edge can start from it. */
  readonly ref?: number;
  readonly changed?: boolean;
}

export interface LayoutNode {
  readonly obj: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly subtitle?: string;
  readonly cells: readonly Cell[];
  readonly shape: Shape;
  /** Laid out horizontally, as an array strip is. */
  readonly horizontal: boolean;
  readonly freed: boolean;
  /** True for the object a structure is drawn from. */
  readonly root: boolean;
}

export interface LayoutEdge {
  readonly from: number;
  readonly to: number;
  readonly key: string;
  /** True when the target no longer exists — drawn broken rather than omitted. */
  readonly dangling: boolean;
}

export interface Layout {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  readonly width: number;
  readonly height: number;
}

const CELL = { width: 46, height: 26 };
const NODE = { padding: 8, titleHeight: 18, minWidth: 96, rowHeight: 19 };
const GAP = { x: 34, y: 54, structure: 40 };

export interface LayoutOptions {
  readonly state: TraceState;
  readonly inferences: ReadonlyMap<number, Inference>;
  readonly language: Parameters<typeof formatValue>[1]["language"];
  /** Objects mutated at the current step, so the drawing can point at what just happened. */
  readonly changed?: ReadonlySet<string>;
  /** Roots to draw. Defaults to every inferred root. */
  readonly roots?: readonly number[];
  /**
   * Include classes, functions and modules.
   *
   * Off for the shaped view: a class object has no data in it, and drawing one beside the list it
   * constructs is noise in the place the user is looking for their data. They remain visible as
   * reference chips in the variables pane, and raw mode turns this on — so nothing is hidden, it is
   * just not in the way.
   */
  readonly includeNonData?: boolean;
}

/** Object kinds that hold program data rather than describing the program. */
const NON_DATA_KINDS = new Set(["class", "function", "module", "opaque"]);

function isDrawable(obj: ObjectLive, includeNonData: boolean): boolean {
  if (obj.freed) return false;
  return includeNonData || !NON_DATA_KINDS.has(obj.kind);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function layoutHeap(options: LayoutOptions): Layout {
  const { state, inferences } = options;
  const placed = new Set<number>();
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];

  const includeNonData = options.includeNonData ?? false;

  const roots = (options.roots ?? [...inferences.values()].filter((i) => i.root).map((i) => i.obj))
    .filter((obj) => {
      const live = state.objects.get(obj);
      return live !== undefined && isDrawable(live, includeNonData);
    })
    .sort((a, b) => a - b);

  let cursorY = GAP.structure / 2;
  let widest = 0;

  for (const rootId of roots) {
    if (placed.has(rootId)) continue;
    const inference = inferences.get(rootId);
    const structure = layoutStructure(rootId, inference, options, placed);
    if (structure.nodes.length === 0) continue;

    // Structures stack downward, each shifted to start below the last.
    for (const node of structure.nodes) {
      nodes.push({ ...node, y: node.y + cursorY });
      placed.add(node.obj);
    }
    edges.push(...structure.edges);
    cursorY += structure.height + GAP.structure;
    widest = Math.max(widest, structure.width);
  }

  // Anything not reached from a root still has to appear. An object the layout could not place is an
  // object the user cannot see, and the heap view is not allowed to hide data.
  const orphans = [...state.objects.values()]
    .filter((obj) => isDrawable(obj, includeNonData) && !placed.has(obj.obj))
    .sort((a, b) => a.obj - b.obj);

  if (orphans.length > 0) {
    let x = GAP.x;
    let rowHeight = 0;
    for (const obj of orphans) {
      const node = recordNode(obj, options, x, cursorY, false);
      if (x + node.width > 900 && x > GAP.x) {
        x = GAP.x;
        cursorY += rowHeight + GAP.y / 2;
        rowHeight = 0;
      }
      nodes.push({ ...node, x, y: cursorY });
      placed.add(obj.obj);
      x += node.width + GAP.x;
      rowHeight = Math.max(rowHeight, node.height);
      widest = Math.max(widest, x);
    }
    cursorY += rowHeight + GAP.structure;
  }

  edges.push(...referenceEdges(nodes, state, placed));

  return {
    nodes,
    edges: dedupe(edges),
    width: Math.max(widest, 240),
    height: Math.max(cursorY, 160),
  };
}

function layoutStructure(
  rootId: number,
  inference: Inference | undefined,
  options: LayoutOptions,
  alreadyPlaced: ReadonlySet<number>,
): Layout {
  const obj = options.state.objects.get(rootId);
  if (!obj) return { nodes: [], edges: [], width: 0, height: 0 };

  const shape = inference?.shape ?? "unknown";

  switch (shape) {
    case "array":
    case "string":
    case "tuple":
    case "stack":
    case "queue":
    case "deque":
      return layoutStrip(obj, shape, options);

    case "matrix":
      return layoutGrid(obj, options);

    case "map":
    case "set":
      return layoutRows(obj, shape, options);

    case "linked_list":
    case "doubly_linked_list":
    case "circular_linked_list":
      return layoutChain(rootId, inference, options, alreadyPlaced);

    case "binary_tree":
    case "bst":
    case "nary_tree":
      return layoutTidyTree(rootId, inference, options, alreadyPlaced);

    case "directed_graph":
    case "undirected_graph":
      return layoutForce(rootId, inference, options, alreadyPlaced);

    default:
      return { nodes: [recordNode(obj, options, 0, 0, true)], edges: [], width: 0, height: 0 };
  }
}

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

/**
 * The rows to show inside a node.
 *
 * `hideLinks` drops fields whose value is drawn as an arrow. Repeating `left → T` inside the box says
 * nothing the line leaving the box does not, and it made every tree node three rows tall — so a
 * three-level tree needed twice the height it should.
 *
 * A link holding nothing is still shown. "next is None" is how you see that you have reached the end
 * of a list, and there is no arrow to say it.
 */
function cellsOf(
  obj: ObjectLive,
  options: LayoutOptions,
  limit = 24,
  hideLinks: readonly string[] = [],
): Cell[] {
  const { state, language, changed } = options;
  const cells: Cell[] = [];
  for (const key of obj.order.slice(0, limit)) {
    const value = obj.slots.get(key);
    if (value === undefined) continue;
    if (hideLinks.includes(key) && isRef(value) && state.objects.has(value.ref)) continue;
    cells.push(cellOf(obj.obj, key, value, state, language, changed));
  }
  if (obj.order.length > limit) {
    cells.push({ key: "…", text: `+${obj.order.length - limit} more` });
  }
  return cells;
}

function cellOf(
  objId: number,
  key: string,
  value: Value,
  state: TraceState,
  language: LayoutOptions["language"],
  changed: ReadonlySet<string> | undefined,
): Cell {
  const cell: Cell = {
    key,
    text: formatValue(value, { language, state, maxLength: 18 }),
    ...(isRef(value) ? { ref: value.ref } : {}),
    ...(changed?.has(`${objId}:${key}`) ? { changed: true } : {}),
  };
  return cell;
}

function recordNode(
  obj: ObjectLive,
  options: LayoutOptions,
  x: number,
  y: number,
  root: boolean,
  hideLinks: readonly string[] = [],
): LayoutNode {
  const cells = cellsOf(obj, options, 10, hideLinks);
  const inference = options.inferences.get(obj.obj);
  const width = Math.max(
    NODE.minWidth,
    ...cells.map((cell) => 34 + cell.key.length * 6.4 + cell.text.length * 6.4),
  );
  return {
    obj: obj.obj,
    x,
    y,
    width: Math.min(width, 240),
    height: NODE.titleHeight + Math.max(1, cells.length) * NODE.rowHeight + NODE.padding,
    title: summarizeObject(obj),
    cells,
    shape: inference?.shape ?? "unknown",
    horizontal: false,
    freed: obj.freed,
    root,
  };
}

// ---------------------------------------------------------------------------
// sequences
// ---------------------------------------------------------------------------

function layoutStrip(obj: ObjectLive, shape: Shape, options: LayoutOptions): Layout {
  const cells = cellsOf(obj, options, 32);
  const width = Math.max(CELL.width * Math.max(cells.length, 1), NODE.minWidth);
  return {
    nodes: [
      {
        obj: obj.obj,
        x: 0,
        y: 0,
        width,
        height: NODE.titleHeight + CELL.height + NODE.padding,
        title: summarizeObject(obj),
        subtitle: activeEnd(shape),
        cells,
        shape,
        horizontal: true,
        freed: obj.freed,
        root: true,
      },
    ],
    edges: [],
    width,
    height: NODE.titleHeight + CELL.height + NODE.padding,
  };
}

/** Which end of a stack or queue is in play, so the drawing says which it is. */
function activeEnd(shape: Shape): string | undefined {
  if (shape === "stack") return "push and pop at the right";
  if (shape === "queue") return "in at the right, out at the left";
  if (shape === "deque") return "both ends in use";
  return undefined;
}

function layoutGrid(obj: ObjectLive, options: LayoutOptions): Layout {
  const { state } = options;
  const nodes: LayoutNode[] = [];
  let width = 0;
  // The container gets a header of its own rather than being implied by its rows.
  //
  // Leaving it out meant the grid itself could not be clicked, so the one inference the user might
  // want to question — "why is this a grid?" — had nothing to select and no way to override.
  let y = NODE.titleHeight;

  for (const [rowIndex, key] of obj.order.entries()) {
    const value = obj.slots.get(key);
    if (!value || !isRef(value)) continue;
    const row = state.objects.get(value.ref);
    if (!row) continue;
    const cells = cellsOf(row, options, 32);
    const rowWidth = Math.max(CELL.width * Math.max(cells.length, 1), NODE.minWidth);
    nodes.push({
      obj: row.obj,
      x: 0,
      y,
      width: rowWidth,
      height: CELL.height,
      title: `${rowIndex}`,
      cells,
      shape: "array",
      horizontal: true,
      freed: row.freed,
      root: false,
    });
    width = Math.max(width, rowWidth);
    y += CELL.height;
  }

  const columns = nodes[0]?.cells.length ?? 0;
  nodes.unshift({
    obj: obj.obj,
    x: 0,
    y: 0,
    width: Math.max(width, NODE.minWidth),
    height: NODE.titleHeight,
    title: `${summarizeObject(obj)} · ${nodes.length}×${columns} grid`,
    cells: [],
    shape: "matrix",
    horizontal: false,
    freed: obj.freed,
    root: true,
  });

  return { nodes, edges: [], width: Math.max(width, NODE.minWidth), height: Math.max(y, CELL.height) };
}

function layoutRows(obj: ObjectLive, shape: Shape, options: LayoutOptions): Layout {
  const node = recordNode(obj, options, 0, 0, true);
  return {
    nodes: [{ ...node, shape }],
    edges: [],
    width: node.width,
    height: node.height,
  };
}

// ---------------------------------------------------------------------------
// chains
// ---------------------------------------------------------------------------

function layoutChain(
  rootId: number,
  inference: Inference | undefined,
  options: LayoutOptions,
  alreadyPlaced: ReadonlySet<number>,
): Layout {
  const { state } = options;
  const forward = inference?.linkFields ?? [];
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  const seen = new Set<number>(alreadyPlaced);

  let current: number | undefined = rootId;
  let x = 0;
  let height = 0;

  while (current !== undefined && !seen.has(current)) {
    const obj = state.objects.get(current);
    if (!obj) break;
    seen.add(current);

    const node = recordNode(obj, options, x, 0, current === rootId, forward);
    nodes.push(node);
    height = Math.max(height, node.height);
    x += node.width + GAP.x;

    // Follow whichever link field actually points somewhere, so a chain built with `next` and a
    // chain built with `child` both lay out as a chain.
    let next: number | undefined;
    for (const field of forward.length > 0 ? forward : [...obj.slots.keys()]) {
      const value = obj.slots.get(field);
      if (value && isRef(value) && state.objects.has(value.ref)) {
        const target = state.objects.get(value.ref);
        if (target && target.typeName === obj.typeName) {
          next = value.ref;
          break;
        }
      }
    }
    current = next;
  }

  return { nodes, edges, width: Math.max(0, x - GAP.x), height };
}

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

/**
 * A tidy tree: children side by side, parents centred above them, no crossings.
 *
 * Leaves are placed left to right in visit order and every parent is centred over its children, which
 * is the essential idea of Reingold and Tilford's algorithm and is enough for the sizes a person reads.
 */
function layoutTidyTree(
  rootId: number,
  inference: Inference | undefined,
  options: LayoutOptions,
  alreadyPlaced: ReadonlySet<number>,
): Layout {
  const { state } = options;
  const linkFields = inference?.linkFields ?? [];
  // Links drawn as arrows are not repeated inside the boxes.
  const drawnLinks = linkFields;
  const visited = new Set<number>(alreadyPlaced);
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];

  let nextLeafX = 0;
  let maxDepth = 0;
  const columnWidth = NODE.minWidth + GAP.x;

  const place = (objId: number, depth: number): number | undefined => {
    if (visited.has(objId)) return undefined;
    const obj = state.objects.get(objId);
    if (!obj) return undefined;
    visited.add(objId);
    maxDepth = Math.max(maxDepth, depth);

    const childIds: { key: string; to: number }[] = [];
    for (const field of linkFields.length > 0 ? linkFields : [...obj.slots.keys()]) {
      const value = obj.slots.get(field);
      if (!value || !isRef(value)) continue;
      const target = state.objects.get(value.ref);
      if (target && target.typeName === obj.typeName) {
        childIds.push({ key: field, to: value.ref });
      }
    }
    // A collection of children, as an n-ary tree usually holds them.
    for (const [field, value] of obj.slots) {
      if (!isRef(value)) continue;
      const container = state.objects.get(value.ref);
      if (!container || (container.kind !== "list" && container.kind !== "array")) continue;
      for (const element of container.slots.values()) {
        if (!isRef(element)) continue;
        const child = state.objects.get(element.ref);
        if (child && child.typeName === obj.typeName) childIds.push({ key: field, to: element.ref });
      }
    }

    const childCentres: number[] = [];
    for (const child of childIds) {
      const centre = place(child.to, depth + 1);
      if (centre !== undefined) childCentres.push(centre);
      edges.push({ from: objId, to: child.to, key: child.key, dangling: false });
    }

    const centre =
      childCentres.length > 0
        ? (Math.min(...childCentres) + Math.max(...childCentres)) / 2
        : (nextLeafX++ * columnWidth) + columnWidth / 2;

    const node = recordNode(obj, options, 0, 0, objId === rootId, drawnLinks);
    nodes.push({
      ...node,
      x: centre - node.width / 2,
      y: depth * GAP.y,
    });
    return centre;
  };

  place(rootId, 0);

  const minX = Math.min(0, ...nodes.map((node) => node.x));
  const shifted = nodes.map((node) => ({ ...node, x: node.x - minX }));
  const width = Math.max(...shifted.map((node) => node.x + node.width), 0);

  return {
    nodes: shifted,
    edges,
    width,
    height: (maxDepth + 1) * GAP.y,
  };
}

// ---------------------------------------------------------------------------
// graphs
// ---------------------------------------------------------------------------

/**
 * A force-directed layout, run for a fixed number of iterations from a fixed starting arrangement.
 *
 * Seeded by object id rather than randomly, so the same graph is drawn the same way every time. A
 * diagram that reshuffles itself on each step would make a user doubt whether the data changed.
 */
function layoutForce(
  rootId: number,
  inference: Inference | undefined,
  options: LayoutOptions,
  alreadyPlaced: ReadonlySet<number>,
): Layout {
  const { state } = options;
  const members = (inference?.members ?? [rootId]).filter(
    (id) => !alreadyPlaced.has(id) && state.objects.has(id),
  );
  if (members.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const edges: LayoutEdge[] = [];
  for (const id of members) {
    const obj = state.objects.get(id);
    if (!obj) continue;
    for (const [key, value] of obj.slots) {
      if (!isRef(value) || !members.includes(value.ref)) continue;
      edges.push({ from: id, to: value.ref, key, dangling: false });
    }
  }

  // Start on a circle, ordered by id: deterministic, and already free of overlaps.
  const radius = Math.max(90, members.length * 22);
  const positions = new Map<number, { x: number; y: number }>();
  members.forEach((id, index) => {
    const angle = (index / members.length) * Math.PI * 2;
    positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  });

  const ideal = NODE.minWidth + GAP.x;
  for (let iteration = 0; iteration < 220; iteration++) {
    const forces = new Map<number, { x: number; y: number }>();
    for (const id of members) forces.set(id, { x: 0, y: 0 });

    // Every pair pushes apart.
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = positions.get(members[i]!)!;
        const b = positions.get(members[j]!)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          // Coincident nodes get a deterministic nudge, from their ids rather than from chance.
          dx = ((members[i]! % 7) - 3) || 1;
          dy = ((members[j]! % 5) - 2) || 1;
          distance = Math.hypot(dx, dy);
        }
        const push = (ideal * ideal) / distance / distance;
        const fx = (dx / distance) * push;
        const fy = (dy / distance) * push;
        forces.get(members[i]!)!.x += fx;
        forces.get(members[i]!)!.y += fy;
        forces.get(members[j]!)!.x -= fx;
        forces.get(members[j]!)!.y -= fy;
      }
    }

    // Edges pull together.
    for (const edge of edges) {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const pull = (distance - ideal) * 0.12;
      const fx = (dx / distance) * pull;
      const fy = (dy / distance) * pull;
      forces.get(edge.from)!.x += fx;
      forces.get(edge.from)!.y += fy;
      forces.get(edge.to)!.x -= fx;
      forces.get(edge.to)!.y -= fy;
    }

    const cooling = 1 - iteration / 220;
    for (const id of members) {
      const force = forces.get(id)!;
      const position = positions.get(id)!;
      position.x += Math.max(-14, Math.min(14, force.x)) * cooling;
      position.y += Math.max(-14, Math.min(14, force.y)) * cooling;
    }
  }

  const nodes = members.map((id) => {
    const obj = state.objects.get(id)!;
    const position = positions.get(id)!;
    const node = recordNode(obj, options, 0, 0, id === rootId, inference?.linkFields ?? []);
    return { ...node, x: position.x, y: position.y };
  });

  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const placed = nodes.map((node) => ({ ...node, x: node.x - minX, y: node.y - minY }));

  return {
    nodes: placed,
    edges,
    width: Math.max(...placed.map((node) => node.x + node.width)),
    height: Math.max(...placed.map((node) => node.y + node.height)),
  };
}

// ---------------------------------------------------------------------------
// edges
// ---------------------------------------------------------------------------

/**
 * References between placed nodes that a structure layout did not already draw.
 *
 * A reference to something absent is reported as dangling rather than dropped. An edge that simply
 * vanishes leaves the user believing a field is empty when it is not.
 */
function referenceEdges(
  nodes: readonly LayoutNode[],
  state: TraceState,
  placed: ReadonlySet<number>,
): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  for (const node of nodes) {
    // Read the object, not the node's cells.
    //
    // Deriving edges from cells meant that hiding a link row to shorten a node also deleted its
    // arrow, so a linked list lost every connection the moment its boxes got tidier. What is drawn
    // inside a node and what is drawn between nodes are separate questions.
    const obj = state.objects.get(node.obj);
    if (!obj) continue;
    for (const [key, value] of obj.slots) {
      if (!isRef(value)) continue;
      const target = state.objects.get(value.ref);
      edges.push({
        from: node.obj,
        to: value.ref,
        key,
        dangling: target === undefined || target.freed || !placed.has(value.ref),
      });
    }
  }
  return edges;
}

function dedupe(edges: readonly LayoutEdge[]): LayoutEdge[] {
  const seen = new Set<string>();
  const unique: LayoutEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.from}:${edge.key}:${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(edge);
  }
  return unique;
}
