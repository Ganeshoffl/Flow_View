/**
 * Operation counters.
 *
 * Cheap to produce once a trace exists, and the fastest route from "this sorts correctly" to "this
 * sorts correctly and does 4,950 comparisons to sort 100 items". Complexity stops being a formula
 * to memorise and becomes a number that grows in front of you.
 */

import { useMemo } from "react";

import type { MetricName } from "@flow-view/trace-schema";
import type { TraceStore } from "@flow-view/trace-store";

import { useTraceVersion } from "./useStore.js";

export interface MetricsPaneProps {
  readonly store: TraceStore;
}

const LABELS: Record<MetricName, string> = {
  comparison: "comparisons",
  swap: "swaps",
  assignment: "assignments",
  call: "calls",
  iteration: "iterations",
  allocation: "allocations",
  read: "reads",
  write: "writes",
};

const ORDER: readonly MetricName[] = [
  "comparison",
  "swap",
  "assignment",
  "iteration",
  "call",
  "allocation",
  "read",
  "write",
];

export function MetricsPane({ store }: MetricsPaneProps) {
  const version = useTraceVersion(store);
  const state = store.state;
  const present = ORDER.filter((name) => state.metrics.has(name));

  /**
   * The busiest counter's running total against step number.
   *
   * This is where complexity stops being a formula and becomes a shape. A quadratic sort draws a
   * visible curve; a linear scan draws a straight line. Only the counter with the most activity is
   * plotted, because a chart with eight lines on it communicates less than one with a shape.
   */
  const spark = useMemo(() => {
    // Chosen by what tells you about cost, not by what happens most.
    //
    // Picking the busiest counter plotted `iterations` for a bubble sort, which is true and dull:
    // iterations grow with the loops you can already see. Comparisons and swaps are what the classic
    // complexity of a sort is counted in, and they are the ones whose curve says something.
    const preference: readonly MetricName[] = [
      "comparison",
      "swap",
      "read",
      "write",
      "allocation",
      "iteration",
      "call",
      "assignment",
    ];
    const leading = preference
      .filter((name) => present.includes(name))
      .map((name) => ({ name, total: state.metrics.get(name) ?? 0 }))
      .find((entry) => entry.total >= 4);
    if (!leading) return undefined;

    const points: { step: number; total: number }[] = [];
    let running = 0;
    let lastStep = 0;
    for (let index = 0; index < store.position; index++) {
      const event = store.eventAt(index);
      if (!event) break;
      if (event.step !== undefined) lastStep = event.step;
      if (event.t === "metric" && event.name === leading.name) {
        running += event.delta;
        points.push({ step: lastStep, total: running });
      }
    }
    if (points.length < 4) return undefined;
    return { name: leading.name, points, total: running, steps: lastStep };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version, present.join(",")]);

  return (
    <div className="fv-pane">
      <div className="fv-pane-title">
        <span>Metrics</span>
        <span className="fv-muted">to this step</span>
      </div>
      <div className="fv-pane-body">
        {present.length === 0 ? (
          <p className="fv-empty">Nothing counted yet.</p>
        ) : (
          <dl className="fv-metrics">
            {present.map((name) => (
              <div key={name} className="fv-metric">
                <dt>{LABELS[name]}</dt>
                <dd>{state.metrics.get(name)?.toLocaleString()}</dd>
              </div>
            ))}
            <div className="fv-metric">
              <dt>live objects</dt>
              <dd>{[...state.objects.values()].filter((o) => !o.freed).length}</dd>
            </div>
            <div className="fv-metric">
              <dt>stack depth</dt>
              <dd>{state.frameOrder.length}</dd>
            </div>
          </dl>
        )}

        {spark ? (
          <figure className="fv-spark">
            <figcaption>
              {LABELS[spark.name]} so far — {spark.total.toLocaleString()} over {spark.steps} steps
            </figcaption>
            <svg
              viewBox="0 0 100 30"
              preserveAspectRatio="none"
              role="img"
              aria-label={`${LABELS[spark.name]} rising to ${spark.total} over ${spark.steps} steps`}
            >
              <polyline
                points={spark.points
                  .map((point) => {
                    const x = (point.step / Math.max(1, spark.steps)) * 100;
                    const y = 30 - (point.total / Math.max(1, spark.total)) * 28;
                    return `${x.toFixed(2)},${y.toFixed(2)}`;
                  })
                  .join(" ")}
              />
            </svg>
          </figure>
        ) : null}
      </div>
    </div>
  );
}
