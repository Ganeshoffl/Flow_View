/**
 * Placing objects on the canvas.
 *
 * The layouts are pure functions of state, so they can be checked precisely without a browser: which
 * objects were drawn, where, and with which edges.
 *
 * The properties worth holding are about honesty as much as geometry. Every live data object must be
 * placed somewhere — an object the layout silently omits is one the user cannot see. A reference to
 * something absent must be drawn as broken rather than left out, since a missing edge reads as an
 * empty field. And the same state must always produce the same coordinates, or the diagram would
 * shuffle itself when nothing had changed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Trace } from "@flow-view/trace-schema";
import { collectAccess, inferStructures } from "@flow-view/inference";
import { TraceStore } from "@flow-view/trace-store";

import { layoutHeap } from "../src/layout.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "inference",
  "test",
  "fixtures",
);

function place(name: string, options: { includeNonData?: boolean } = {}) {
  const trace = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Trace;
  const store = new TraceStore();
  store.load(trace);
  store.fastForward();
  const inference = inferStructures(store.state, { access: collectAccess(store) });
  const layout = layoutHeap({
    state: store.state,
    inferences: inference.byObject,
    language: "python",
    ...options,
  });
  return { store, inference, layout };
}

describe("what gets drawn", () => {
  it("leaves classes and functions out of the shaped view", () => {
    // A class object holds no program data. Drawing one beside the list it constructs puts noise in
    // the place the user is looking for their data; it stays visible as a chip in the variables pane.
    const { store, layout } = place("linked-list");
    const drawn = new Set(layout.nodes.map((node) => node.obj));
    for (const obj of store.state.objects.values()) {
      if (obj.kind === "class" || obj.kind === "function" || obj.kind === "module") {
        expect(drawn.has(obj.obj), `${obj.kind} ${obj.typeName} should not be drawn`).toBe(false);
      }
    }
  });

  it("draws everything, classes included, in raw mode", () => {
    // Raw mode is the escape hatch that keeps "nothing is hidden" true.
    const { store, layout } = place("linked-list", { includeNonData: true });
    const drawn = new Set(layout.nodes.map((node) => node.obj));
    const live = [...store.state.objects.values()].filter((obj) => !obj.freed);
    for (const obj of live) {
      expect(drawn.has(obj.obj), `${obj.typeName} #${obj.obj} was not drawn`).toBe(true);
    }
  });

  it("places every live data object somewhere", () => {
    for (const name of ["linked-list", "bst", "matrix", "adjacency", "plain-dict", "stack"]) {
      const { store, layout } = place(name);
      const drawn = new Set(layout.nodes.map((node) => node.obj));
      const missing = [...store.state.objects.values()].filter(
        (obj) =>
          !obj.freed &&
          !["class", "function", "module", "opaque"].includes(obj.kind) &&
          !drawn.has(obj.obj),
      );
      expect(missing.map((obj) => `${obj.typeName}#${obj.obj}`), `${name} omitted objects`).toEqual(
        [],
      );
    }
  });

  it("never places the same object twice", () => {
    for (const name of ["linked-list", "bst", "matrix", "tree-with-cycle"]) {
      const { layout } = place(name);
      const ids = layout.nodes.map((node) => node.obj);
      expect(new Set(ids).size, `${name} drew an object more than once`).toBe(ids.length);
    }
  });
});

describe("geometry", () => {
  it("lays a linked list out left to right", () => {
    const { layout } = place("linked-list");
    const nodes = [...layout.nodes].sort((a, b) => a.x - b.x);
    expect(nodes.length).toBeGreaterThanOrEqual(3);
    // A chain advances along x and stays on one row.
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i]!.x).toBeGreaterThan(nodes[i - 1]!.x);
      expect(nodes[i]!.y).toBe(nodes[0]!.y);
    }
  });

  it("lays a tree out in rows by depth, with the root centred over its children", () => {
    const { store, layout } = place("bst");
    const rows = new Map<number, typeof layout.nodes>();
    for (const node of layout.nodes) {
      rows.set(node.y, [...(rows.get(node.y) ?? []), node]);
    }
    expect(rows.size, "a tree should occupy more than one row").toBeGreaterThan(1);

    const rootValue = store.state.objects;
    void rootValue;
    const topRow = [...rows.entries()].sort((a, b) => a[0] - b[0])[0]![1];
    expect(topRow, "exactly one node at the top of a tree").toHaveLength(1);

    const root = topRow[0]!;
    const children = layout.edges
      .filter((edge) => edge.from === root.obj)
      .map((edge) => layout.nodes.find((node) => node.obj === edge.to))
      .filter((node): node is NonNullable<typeof node> => node !== undefined);

    if (children.length === 2) {
      const centres = children.map((child) => child.x + child.width / 2).sort((a, b) => a - b);
      const rootCentre = root.x + root.width / 2;
      expect(rootCentre).toBeGreaterThan(centres[0]!);
      expect(rootCentre).toBeLessThan(centres[1]!);
    }
  });

  it("draws an array as one horizontal strip of cells", () => {
    const { layout } = place("plain-array");
    const strip = layout.nodes.find((node) => node.horizontal);
    expect(strip, "an array should be laid out horizontally").toBeDefined();
    expect(strip!.cells.length).toBeGreaterThanOrEqual(3);
  });

  it("gives a grid a header of its own so it can be selected", () => {
    // Without this the grid itself had no node, so the one inference a user might question had
    // nothing to click and no way to override.
    const { layout } = place("matrix");
    const header = layout.nodes.find((node) => node.shape === "matrix");
    expect(header, "the grid container must be drawn").toBeDefined();
    expect(header!.title).toContain("grid");
  });

  it("keeps every node inside the reported bounds", () => {
    for (const name of ["linked-list", "bst", "matrix", "adjacency"]) {
      const { layout } = place(name);
      for (const node of layout.nodes) {
        expect(node.x, `${name}: node ${node.obj} is left of the canvas`).toBeGreaterThanOrEqual(0);
        expect(node.y, `${name}: node ${node.obj} is above the canvas`).toBeGreaterThanOrEqual(0);
        expect(node.x + node.width, `${name}: node ${node.obj} overflows`).toBeLessThanOrEqual(
          layout.width + 1,
        );
      }
    }
  });
});

describe("edges", () => {
  it("connects a chain in order", () => {
    const { layout } = place("linked-list");
    const next = layout.edges.filter((edge) => edge.key === "next");
    expect(next.length).toBeGreaterThanOrEqual(2);
    expect(next.every((edge) => !edge.dangling)).toBe(true);
  });

  it("draws a cycle's closing edge rather than dropping it", () => {
    const { layout } = place("circular-list");
    const edges = layout.edges.filter((edge) => edge.key === "next");
    // Three nodes, three links: the one that closes the ring must be there too.
    expect(edges).toHaveLength(3);
  });

  it("never reports an edge to an object that was drawn as dangling", () => {
    for (const name of ["linked-list", "bst", "matrix", "adjacency"]) {
      const { layout } = place(name);
      const drawn = new Set(layout.nodes.map((node) => node.obj));
      for (const edge of layout.edges) {
        if (drawn.has(edge.to)) {
          expect(edge.dangling, `${name}: edge to a drawn object marked dangling`).toBe(false);
        }
      }
    }
  });

  it("does not duplicate an edge", () => {
    const { layout } = place("bst");
    const keys = layout.edges.map((edge) => `${edge.from}:${edge.key}:${edge.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("determinism", () => {
  it("produces identical coordinates for identical state", () => {
    for (const name of ["linked-list", "bst", "adjacency", "tree-with-cycle"]) {
      const first = place(name).layout;
      const second = place(name).layout;
      expect(second.nodes.map((n) => [n.obj, n.x, n.y])).toEqual(
        first.nodes.map((n) => [n.obj, n.x, n.y]),
      );
    }
  });

  it("places a force-directed graph the same way every time", () => {
    // Seeded from object ids rather than randomly: a graph that rearranged itself on every step would
    // make the user doubt whether their data had changed.
    const a = place("adjacency").layout;
    const b = place("adjacency").layout;
    expect(b.nodes.map((n) => [n.obj, Math.round(n.x), Math.round(n.y)])).toEqual(
      a.nodes.map((n) => [n.obj, Math.round(n.x), Math.round(n.y)]),
    );
  });
});
