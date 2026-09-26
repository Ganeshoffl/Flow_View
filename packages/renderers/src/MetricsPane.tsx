/**
 * Operation counters.
 *
 * Cheap to produce once a trace exists, and the fastest route from "this sorts correctly" to "this
 * sorts correctly and does 4,950 comparisons to sort 100 items". Complexity stops being a formula
 * to memorise and becomes a number that grows in front of you.
 */

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
  useTraceVersion(store);
  const state = store.state;
  const present = ORDER.filter((name) => state.metrics.has(name));

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
      </div>
    </div>
  );
}
