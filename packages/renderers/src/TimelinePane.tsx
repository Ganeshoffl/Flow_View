/**
 * The call tree over time.
 *
 * Each call is a bar, placed by the steps it spanned and stacked by depth, so recursion reads as a
 * staircase and a loop calling a function reads as a row of repeats. Clicking a bar seeks to that call.
 *
 * This is the view that pays for keeping frames after they return. A stack that erased its own history
 * could not draw this, and "what did that call return, again?" is a question people ask immediately
 * after it has gone.
 */

import { useMemo } from "react";

import type { Language } from "@flow-view/trace-schema";
import type { FrameLive, TraceStore } from "@flow-view/trace-store";

import { formatValue } from "./format.js";
import { useTraceVersion } from "./useStore.js";

export interface TimelinePaneProps {
  readonly store: TraceStore;
  readonly language: Language;
}

interface Bar {
  readonly frame: FrameLive;
  readonly depth: number;
  readonly from: number;
  readonly to: number;
}

export function TimelinePane({ store, language }: TimelinePaneProps) {
  const version = useTraceVersion(store);

  const { bars, span, depth } = useMemo(() => {
    const state = store.state;
    const lastStep = Math.max(1, state.step);

    // Depth by walking callers, which is the only place the nesting is recorded.
    const depthOf = (frame: FrameLive): number => {
      let level = 0;
      let caller = frame.caller;
      const guard = new Set<number>();
      while (caller !== undefined && !guard.has(caller)) {
        guard.add(caller);
        level++;
        caller = state.frames.get(caller)?.caller;
      }
      return level;
    };

    const collected: Bar[] = [];
    for (const frame of state.frames.values()) {
      const from = frame.pushedAtStep;
      if (from > lastStep) continue;
      // A call still running is drawn up to the playhead, not to some guessed end.
      const to = frame.poppedAtStep ?? lastStep;
      collected.push({ frame, depth: depthOf(frame), from, to: Math.max(to, from) });
    }

    collected.sort((a, b) => a.from - b.from || a.depth - b.depth);
    return {
      bars: collected,
      span: lastStep,
      depth: Math.max(0, ...collected.map((bar) => bar.depth)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);

  const rowHeight = 17;

  return (
    <div className="fv-pane fv-timeline">
      <div className="fv-pane-title">
        <span>Timeline</span>
        <span className="fv-muted">{bars.length} calls</span>
      </div>

      <div className="fv-pane-body fv-timeline-body">
        {bars.length === 0 ? (
          <p className="fv-empty">No calls yet.</p>
        ) : (
          <div
            className="fv-timeline-chart"
            style={{ height: `${(depth + 1) * rowHeight + 6}px` }}
          >
            {bars.map((bar) => {
              const left = (bar.from / Math.max(1, span)) * 100;
              const width = Math.max(1.2, ((bar.to - bar.from) / Math.max(1, span)) * 100);
              const active = bar.frame.active;
              return (
                <button
                  key={bar.frame.frame}
                  type="button"
                  className={`fv-timeline-bar${active ? " is-active" : ""}${
                    bar.frame.kind === "library" ? " is-library" : ""
                  }`}
                  style={{
                    left: `${left}%`,
                    width: `${Math.min(width, 100 - left)}%`,
                    top: `${bar.depth * rowHeight + 3}px`,
                  }}
                  onClick={() => store.seekStep(bar.from)}
                  title={describe(bar, store, language)}
                >
                  <span className="fv-timeline-label">{bar.frame.func}</span>
                </button>
              );
            })}

            {/* Where the playhead is, so the bars have something to be read against. */}
            <div className="fv-timeline-playhead" style={{ left: "100%" }} />
          </div>
        )}
      </div>
    </div>
  );
}

function describe(bar: Bar, store: TraceStore, language: Language): string {
  const { frame } = bar;
  const args = frame.args
    .map((arg) => `${arg.name} = ${formatValue(arg.value, { language, state: store.state })}`)
    .join(", ");
  const lines = [`${frame.func}(${args})`, `steps ${bar.from} to ${bar.to}`];
  if (frame.recursionDepth > 0) lines.push(`recursion depth ${frame.recursionDepth}`);
  if (!frame.active) {
    lines.push(
      frame.returnValue === undefined
        ? "ended without a recorded value"
        : `returned ${formatValue(frame.returnValue, { language, state: store.state })}`,
    );
  } else {
    lines.push("still running");
  }
  return lines.join("\n");
}
