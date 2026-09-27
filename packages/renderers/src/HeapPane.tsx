/**
 * The heap, drawn.
 *
 * Canvas rather than SVG: a few hundred DOM nodes with edges between them stops being smooth long
 * before the 500 nodes this has to sustain, and the drawing is entirely redrawn each frame anyway.
 *
 * Node positions are **animated between layouts** rather than jumped to. An insertion should read as
 * a node arriving and its neighbours making room; if the whole diagram snapped to a new arrangement
 * the user would have to work out what moved, which is the opposite of the point.
 *
 * Two things here exist to keep the view honest. A wrong inference is correctable — clicking a node
 * offers the shapes it could be — and the inference's evidence is always readable, so a strange
 * drawing can be interrogated instead of merely doubted.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Language, Shape } from "@flow-view/trace-schema";
import { SHAPE_VALUES } from "@flow-view/trace-schema";
import { collectAccess, inferStructures } from "@flow-view/inference";
import type { TraceStore } from "@flow-view/trace-store";

import { type Layout, type LayoutNode, layoutHeap } from "./layout.js";
import { shapeLabel } from "./format.js";
import { useTraceVersion } from "./useStore.js";

export interface HeapPaneProps {
  readonly store: TraceStore;
  readonly language: Language;
  readonly highlightedObject?: number | undefined;
  readonly onHighlightObject?: (obj: number | undefined) => void;
}

const COLOURS = {
  node: "#1d212d",
  nodeRoot: "#222a3d",
  border: "#394054",
  borderRoot: "#62a0ff",
  text: "#e4e7ee",
  muted: "#8b93a7",
  edge: "#566078",
  key: "#62a0ff",
  attention: "#ffcf5c",
  gone: "#ff7a7a",
} as const;

/** How quickly a node slides to a new position. 1 is instant. */
const EASE = 0.28;

export function HeapPane({
  store,
  language,
  highlightedObject,
  onHighlightObject,
}: HeapPaneProps) {
  const version = useTraceVersion(store);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const [overrides, setOverrides] = useState<Map<number, Shape>>(new Map());
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [rawMode, setRawMode] = useState(false);

  /** Slots written at the current step, so the drawing can point at what just happened. */
  const changed = useMemo(() => {
    const keys = new Set<string>();
    const current = store.currentEvent();
    if (!current) return keys;
    for (let index = store.position - 1; index >= 0; index--) {
      const event = store.eventAt(index);
      if (!event) break;
      if (event.step !== undefined && event.step !== current.step) break;
      if (event.t === "obj_set") keys.add(`${event.obj}:${String(event.key)}`);
    }
    return keys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);

  const inference = useMemo(
    () => inferStructures(store.state, { overrides, access: collectAccess(store) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version, overrides],
  );

  const layout = useMemo(
    () =>
      layoutHeap({
        state: store.state,
        // Raw mode draws every object as plain fields with its references, including the classes and
        // functions the shaped view leaves out. Always one click away, because a shape the user does
        // not believe must never be the only thing on offer.
        inferences: rawMode ? new Map() : inference.byObject,
        language,
        changed,
        ...(rawMode ? { roots: [], includeNonData: true } : {}),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version, inference, language, changed, rawMode],
  );

  // Animated positions, carried between layouts by object id.
  const positions = useRef(new Map<number, { x: number; y: number }>());
  const frame = useRef<number | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const ratio = window.devicePixelRatio || 1;
    const cssWidth = Math.max(wrap.clientWidth, layout.width + 40);
    const cssHeight = Math.max(wrap.clientHeight, layout.height + 40);
    if (canvas.width !== cssWidth * ratio || canvas.height !== cssHeight * ratio) {
      canvas.width = cssWidth * ratio;
      canvas.height = cssHeight * ratio;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }

    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
    context.translate(20, 14);

    // Ease each node toward its target, and report whether anything is still moving.
    let moving = false;
    const live = new Map<number, { x: number; y: number }>();
    for (const node of layout.nodes) {
      const previous = positions.current.get(node.obj);
      if (!previous) {
        live.set(node.obj, { x: node.x, y: node.y });
        continue;
      }
      const x = previous.x + (node.x - previous.x) * EASE;
      const y = previous.y + (node.y - previous.y) * EASE;
      if (Math.abs(node.x - x) > 0.4 || Math.abs(node.y - y) > 0.4) moving = true;
      live.set(node.obj, { x, y });
    }
    positions.current = live;

    const at = (objId: number) => live.get(objId);
    const nodeById = new Map(layout.nodes.map((node) => [node.obj, node] as const));

    drawEdges(context, layout, nodeById, at);
    for (const node of layout.nodes) {
      const position = at(node.obj);
      if (!position) continue;
      drawNode(context, node, position, {
        highlighted: node.obj === highlightedObject,
        selected: node.obj === selected,
      });
    }

    if (moving) {
      frame.current = requestAnimationFrame(draw);
    } else {
      frame.current = null;
    }
  }, [layout, highlightedObject, selected]);

  useEffect(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(draw);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [draw]);

  const hitTest = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>): LayoutNode | undefined => {
      const canvas = canvasRef.current;
      if (!canvas) return undefined;
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left - 20;
      const y = event.clientY - bounds.top - 14;
      return layout.nodes.find((node) => {
        const position = positions.current.get(node.obj) ?? node;
        return (
          x >= position.x &&
          x <= position.x + node.width &&
          y >= position.y &&
          y <= position.y + node.height
        );
      });
    },
    [layout],
  );

  const selectedInference = selected === undefined ? undefined : inference.byObject.get(selected);

  /** One entry per structure drawn, for the legend. */
  const structures = useMemo(() => {
    const drawn = new Set(layout.nodes.map((node) => node.obj));
    return [...inference.byObject.values()]
      .filter((entry) => entry.root && drawn.has(entry.obj))
      .sort((a, b) => a.obj - b.obj);
  }, [inference, layout]);

  return (
    <div className="fv-pane fv-heap">
      <div className="fv-pane-title">
        <span>Heap</span>
        <span className="fv-heap-actions">
          <button
            type="button"
            className={`fv-mini${rawMode ? " is-on" : ""}`}
            onClick={() => setRawMode((value) => !value)}
            title="Draw every object as plain fields, with no shape inferred"
          >
            raw
          </button>
          <span className="fv-muted">{layout.nodes.length} objects</span>
        </span>
      </div>

      {/*
        What the heap contains, in words.

        Added because the canvas alone made the evidence undiscoverable: you had to already know that
        clicking a node would explain it. This says what was found and offers the explanation without
        requiring the user to go looking for it.
      */}
      {structures.length > 0 ? (
        <div className="fv-structures">
          {structures.map((entry) => (
            <button
              key={entry.obj}
              type="button"
              className={`fv-structure${entry.obj === selected ? " is-selected" : ""}`}
              data-shape={entry.shape}
              data-confidence={entry.confidence}
              onClick={() => setSelected(entry.obj === selected ? undefined : entry.obj)}
              onMouseEnter={() => onHighlightObject?.(entry.obj)}
              onMouseLeave={() => onHighlightObject?.(undefined)}
              title={entry.evidence.join("\n")}
            >
              {shapeLabel(entry.shape) || entry.shape}
              {entry.members.length > 1 ? (
                <span className="fv-structure-size">{entry.members.length}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="fv-heap-canvas" ref={wrapRef}>
        {layout.nodes.length === 0 ? (
          <p className="fv-empty">No objects on the heap yet.</p>
        ) : (
          <canvas
            ref={canvasRef}
            onMouseMove={(event) => {
              const node = hitTest(event);
              onHighlightObject?.(node?.obj);
            }}
            onMouseLeave={() => onHighlightObject?.(undefined)}
            onClick={(event) => {
              const node = hitTest(event);
              setSelected(node?.obj);
            }}
          />
        )}
      </div>

      {selectedInference ? (
        <div className="fv-heap-detail">
          <div className="fv-heap-detail-head">
            <strong>{shapeLabel(selectedInference.shape) || selectedInference.shape}</strong>
            <span className={`fv-confidence is-${selectedInference.confidence}`}>
              {selectedInference.confidence} confidence
            </span>
            <button type="button" className="fv-mini" onClick={() => setSelected(undefined)}>
              close
            </button>
          </div>

          {/* Evidence is always shown. An inference the user cannot interrogate is worse than none. */}
          <ul className="fv-evidence">
            {selectedInference.evidence.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>

          <label className="fv-override">
            draw it as
            <select
              value={overrides.get(selectedInference.obj) ?? selectedInference.shape}
              onChange={(event) => {
                const shape = event.target.value as Shape;
                setOverrides((current) => {
                  const next = new Map(current);
                  if (shape === selectedInference.shape) next.delete(selectedInference.obj);
                  else next.set(selectedInference.obj, shape);
                  return next;
                });
              }}
            >
              {SHAPE_VALUES.map((shape) => (
                <option key={shape} value={shape}>
                  {shapeLabel(shape) || shape}
                </option>
              ))}
            </select>
            {overrides.has(selectedInference.obj) ? (
              <button
                type="button"
                className="fv-mini"
                onClick={() =>
                  setOverrides((current) => {
                    const next = new Map(current);
                    next.delete(selectedInference.obj);
                    return next;
                  })
                }
              >
                undo my choice
              </button>
            ) : null}
          </label>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

type Point = { x: number; y: number };

function drawEdges(
  context: CanvasRenderingContext2D,
  layout: Layout,
  nodeById: ReadonlyMap<number, LayoutNode>,
  at: (obj: number) => Point | undefined,
): void {
  for (const edge of layout.edges) {
    const fromNode = nodeById.get(edge.from);
    const from = at(edge.from);
    if (!fromNode || !from) continue;

    const toNode = nodeById.get(edge.to);
    const to = at(edge.to);

    const start = {
      x: from.x + fromNode.width,
      y: from.y + fromNode.height / 2,
    };

    if (edge.dangling || !toNode || !to) {
      // A reference whose target is gone. Drawn as a stub that stops short, because an edge that
      // simply disappeared would read as an empty field.
      context.save();
      context.strokeStyle = "#ff7a7a";
      context.setLineDash([4, 3]);
      context.lineWidth = 1.4;
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(start.x + 26, start.y);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = "#ff7a7a";
      context.font = "10px ui-monospace, monospace";
      context.fillText("gone", start.x + 30, start.y + 3);
      context.restore();
      continue;
    }

    const end = { x: to.x, y: to.y + toNode.height / 2 };
    const backwards = end.x < start.x;
    const startPoint = backwards
      ? { x: from.x, y: from.y + fromNode.height / 2 }
      : start;
    const endPoint = backwards
      ? { x: to.x + toNode.width, y: to.y + toNode.height / 2 }
      : end;

    context.save();
    context.strokeStyle = "#566078";
    context.lineWidth = 1.4;
    context.beginPath();
    context.moveTo(startPoint.x, startPoint.y);
    const midX = (startPoint.x + endPoint.x) / 2;
    context.bezierCurveTo(midX, startPoint.y, midX, endPoint.y, endPoint.x, endPoint.y);
    context.stroke();

    // Arrowhead, pointing the way the reference goes.
    const direction = endPoint.x >= startPoint.x ? 1 : -1;
    context.fillStyle = "#566078";
    context.beginPath();
    context.moveTo(endPoint.x, endPoint.y);
    context.lineTo(endPoint.x - 6 * direction, endPoint.y - 3.5);
    context.lineTo(endPoint.x - 6 * direction, endPoint.y + 3.5);
    context.closePath();
    context.fill();
    context.restore();
  }
}

function drawNode(
  context: CanvasRenderingContext2D,
  node: LayoutNode,
  position: Point,
  flags: { highlighted: boolean; selected: boolean },
): void {
  const { x, y } = position;

  context.save();
  context.fillStyle = node.root ? COLOURS.nodeRoot : COLOURS.node;
  context.strokeStyle = flags.selected
    ? "#ffcf5c"
    : flags.highlighted
      ? COLOURS.borderRoot
      : node.root
        ? COLOURS.borderRoot
        : COLOURS.border;
  context.lineWidth = flags.selected || flags.highlighted ? 2 : 1;

  roundRect(context, x, y, node.width, node.height, 6);
  context.fill();
  context.stroke();

  if (node.freed) {
    // A freed object stays visible, marked, rather than disappearing: what it held is still worth
    // reading, and a pointer into it is the thing a user most needs to see.
    context.globalAlpha = 0.45;
  }

  context.fillStyle = COLOURS.muted;
  context.font = "10px ui-sans-serif, system-ui, sans-serif";
  context.fillText(truncate(node.title, Math.floor(node.width / 6)), x + 7, y + 12);

  if (node.subtitle) {
    context.fillStyle = "#8b93a7";
    context.font = "9px ui-sans-serif, system-ui, sans-serif";
    context.fillText(truncate(node.subtitle, Math.floor(node.width / 5)), x + 7, y + node.height - 4);
  }

  context.font = "11px ui-monospace, monospace";

  if (node.horizontal) {
    const cellWidth = node.cells.length > 0 ? node.width / node.cells.length : node.width;
    node.cells.forEach((cell, index) => {
      const cellX = x + index * cellWidth;
      const cellY = y + 16;
      context.strokeStyle = cell.changed ? "#ffcf5c" : COLOURS.border;
      context.lineWidth = cell.changed ? 1.6 : 1;
      context.strokeRect(cellX, cellY, cellWidth, 24);
      context.fillStyle = COLOURS.text;
      context.fillText(
        truncate(cell.text, Math.floor(cellWidth / 6.4)),
        cellX + 4,
        cellY + 16,
      );
      context.fillStyle = COLOURS.muted;
      context.font = "8px ui-monospace, monospace";
      context.fillText(cell.key, cellX + 2, cellY + 7);
      context.font = "11px ui-monospace, monospace";
    });
  } else {
    node.cells.forEach((cell, index) => {
      const rowY = y + 16 + index * 19;
      if (cell.changed) {
        context.fillStyle = "rgba(255, 207, 92, 0.16)";
        context.fillRect(x + 2, rowY + 2, node.width - 4, 16);
      }
      context.fillStyle = "#62a0ff";
      context.fillText(truncate(cell.key, 12), x + 7, rowY + 14);
      context.fillStyle = COLOURS.text;
      const keyWidth = Math.min(12, cell.key.length) * 6.6 + 12;
      context.fillText(
        truncate(cell.text, Math.floor((node.width - keyWidth) / 6.4)),
        x + keyWidth,
        rowY + 14,
      );
    });
  }

  context.restore();
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function truncate(text: string, limit: number): string {
  if (limit <= 1) return "";
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
