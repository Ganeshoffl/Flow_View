/**
 * One cell of the pane grid, with a control to give it the whole grid.
 *
 * The grid hands every pane a share of the screen, which is right when you are watching the code, the
 * stack and the heap move together — and wrong the moment you want to actually *read* one of them. A
 * forty-line program arrives showing eight lines; a tree with a dozen nodes is drawn into a box the
 * height of four. Both are legible, and neither is comfortable.
 *
 * So each pane can take over the grid and hand it back. Deliberately a focus mode rather than draggable
 * splitters: the question being answered is "let me see this properly", and a drag handle answers it by
 * asking the user to do layout work first.
 *
 * Two things that matter more than they look:
 *
 * - **The run controls and the playback bar stay put**, because they live outside the grid. So you can
 *   expand the heap and then keep stepping, which is the entire reason to expand the heap.
 * - **Escape collapses.** Anything that takes over the screen owes the user that.
 */

import { useCallback, useEffect, useState } from "react";

/** The grid cells, matching the CSS grid areas. */
export type AreaName =
  | "code"
  | "stack"
  | "vars"
  | "heap"
  | "narration"
  | "side"
  | "timeline";

/** What each area is called when the control describes itself to a screen reader. */
const LABELS: Record<AreaName, string> = {
  code: "the code",
  stack: "the call stack",
  vars: "the variables",
  heap: "the objects",
  narration: "the narration",
  side: "the output and metrics",
  timeline: "the timeline",
};

export interface ExpandedArea {
  readonly expanded: AreaName | undefined;
  readonly toggle: (name: AreaName) => void;
  /** Class for the grid container, so CSS can collapse the other cells. */
  readonly mainClass: string;
}

export function useExpandedArea(): ExpandedArea {
  const [expanded, setExpanded] = useState<AreaName | undefined>(undefined);

  const toggle = useCallback((name: AreaName) => {
    setExpanded((current) => (current === name ? undefined : name));
  }, []);

  useEffect(() => {
    if (expanded === undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Not preventDefault: Escape may mean something to whatever has focus as well, and this is the
      // less important of the two claims on it.
      setExpanded(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  return {
    expanded,
    toggle,
    mainClass: expanded === undefined ? "fv-main" : "fv-main has-expanded",
  };
}

export interface AreaProps {
  readonly name: AreaName;
  readonly area: ExpandedArea;
  readonly children: React.ReactNode;
}

export function Area({ name, area, children }: AreaProps) {
  const isExpanded = area.expanded === name;
  const label = LABELS[name];
  return (
    <div className={`fv-area is-${name}${isExpanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="fv-expand"
        aria-expanded={isExpanded}
        aria-label={isExpanded ? `Shrink ${label} back into the grid` : `Expand ${label}`}
        title={isExpanded ? "Back to the grid  (Esc)" : `Expand ${label}`}
        onClick={() => area.toggle(name)}
      >
        {/* A glyph as well as a label, so the state is not carried by position alone. */}
        <span aria-hidden="true">{isExpanded ? "⤡" : "⤢"}</span>
      </button>
      {children}
    </div>
  );
}
