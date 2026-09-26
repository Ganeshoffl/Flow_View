/**
 * Source with the executing line marked.
 *
 * Three signals, layered: the line running now, how many times each line has run, and — where a
 * branch was decided — the condition and which way control went. The last one is the difference
 * between watching a program and understanding it: "the loop ended" is an observation, "`i < 5` was
 * false, so the loop ended" is an explanation.
 *
 * Phase 1 replaces this with CodeMirror 6 for syntax highlighting. The structure here is what the
 * gate needs and what the real editor will slot into.
 */

import { useEffect, useMemo, useRef } from "react";

import type { Language, TraceEvent } from "@flow-view/trace-schema";
import type { TraceStore } from "@flow-view/trace-store";
import { currentLocation } from "@flow-view/trace-store";

import { useTraceVersion } from "./useStore.js";

export interface CodePaneProps {
  readonly store: TraceStore;
  readonly source: readonly string[];
  readonly language: Language;
  /** Called when a line is clicked, so a parent can seek. */
  readonly onSelectLine?: (line: number) => void;
}

interface LineInfo {
  readonly visits: number;
  readonly branch?: { expr: string; outcome: "taken" | "not_taken" };
}

export function CodePane({ store, source, language, onSelectLine }: CodePaneProps) {
  const version = useTraceVersion(store);
  const location = currentLocation(store.state);
  const activeLine = location?.line;
  const activeRef = useRef<HTMLDivElement | null>(null);

  // Per-line history up to the playhead. Recomputed when the playhead moves, which is the only
  // time it can change.
  const lines = useMemo(() => {
    const info = new Map<number, LineInfo>();
    for (let i = 0; i < store.position; i++) {
      const event = store.eventAt(i);
      if (!event?.line) continue;
      const existing = info.get(event.line) ?? { visits: 0 };
      const visits = event.t === "step_line" ? existing.visits + 1 : existing.visits;
      const branch = branchOf(event) ?? existing.branch;
      info.set(event.line, branch ? { visits, branch } : { visits });
    }
    return info;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeLine]);

  const maxVisits = Math.max(1, ...[...lines.values()].map((l) => l.visits));

  return (
    <div className="fv-pane fv-code">
      <div className="fv-pane-title">
        <span>{location?.path ?? "source"}</span>
        <span className="fv-muted">{language}</span>
      </div>
      <div className="fv-code-body">
        {source.map((text, index) => {
          const line = index + 1;
          const info = lines.get(line);
          const isActive = line === activeLine;
          const heat = info ? Math.min(1, info.visits / maxVisits) : 0;
          return (
            <div
              key={line}
              ref={isActive ? activeRef : undefined}
              className={`fv-code-line${isActive ? " is-active" : ""}${info ? " is-visited" : ""}`}
              onClick={() => onSelectLine?.(line)}
              // Executed lines are tinted by visit count, so a hot loop body is visible at a glance.
              style={heat > 0 ? { ["--fv-heat" as string]: heat.toFixed(3) } : undefined}
            >
              <span className="fv-gutter" title={info ? `executed ${info.visits}×` : undefined}>
                {line}
              </span>
              <span className="fv-visits">{info && info.visits > 1 ? `${info.visits}×` : ""}</span>
              <code className="fv-code-text">{text || " "}</code>
              {info?.branch ? (
                <span
                  className={`fv-branch is-${info.branch.outcome}`}
                  title={`${info.branch.expr} was ${
                    info.branch.outcome === "taken" ? "true, so this branch ran" : "false, so this branch was skipped"
                  }`}
                >
                  {info.branch.expr}
                  <span className="fv-branch-outcome">
                    {info.branch.outcome === "taken" ? "taken" : "skipped"}
                  </span>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function branchOf(event: TraceEvent): LineInfo["branch"] {
  if (event.t !== "branch") return undefined;
  return { expr: event.expr, outcome: event.outcome };
}
