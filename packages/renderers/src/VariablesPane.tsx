/**
 * Variables in the focused frame.
 *
 * Two things are doing real work here. Values that changed at the current step are flagged, so a
 * user stepping through sees *what this line did* rather than having to diff two screens in their
 * head. And references are rendered as chips that highlight their target, which is how aliasing
 * stops being invisible: hover `second` and watch the same object light up under `first`.
 */

import { useMemo } from "react";

import type { Language, Value } from "@flow-view/trace-schema";
import { isRef } from "@flow-view/trace-schema";
import type { TraceStore } from "@flow-view/trace-store";
import { focusFrame } from "@flow-view/trace-store";

import { formatValue, shapeLabel, typeOfValue } from "./format.js";
import { ChangedIcon } from "./icons.js";
import { useTraceVersion } from "./useStore.js";

export interface VariablesPaneProps {
  readonly store: TraceStore;
  readonly language: Language;
  /** Heap object currently highlighted, for cross-pane linking. */
  readonly highlightedObject?: number | undefined;
  readonly onHighlightObject?: (obj: number | undefined) => void;
}

export function VariablesPane({
  store,
  language,
  highlightedObject,
  onHighlightObject,
}: VariablesPaneProps) {
  const version = useTraceVersion(store);
  const state = store.state;
  const frame = focusFrame(state);

  /** Names written at the current step, so the change can be pointed at. */
  const changed = useMemo(() => {
    const names = new Set<string>();
    const current = store.currentEvent();
    if (!current || !frame) return names;
    for (let i = store.position - 1; i >= 0; i--) {
      const event = store.eventAt(i);
      if (!event) break;
      if (event.step !== undefined && event.step !== current.step) break;
      if (event.t === "var_set" && event.frame === frame.frame) names.add(event.name);
    }
    return names;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version, frame]);

  if (!frame) {
    return (
      <div className="fv-pane">
        <div className="fv-pane-title">
          <span>Variables</span>
        </div>
        <div className="fv-pane-body">
          <p className="fv-empty">No frame yet. Step forward to begin.</p>
        </div>
      </div>
    );
  }

  const entries = [...frame.bindings.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="fv-pane">
      <div className="fv-pane-title">
        <span>Variables</span>
        <span className="fv-muted">{frame.func}</span>
      </div>
      <div className="fv-pane-body">
        {entries.length === 0 ? (
          <p className="fv-empty">No variables bound in this frame.</p>
        ) : (
          <table className="fv-vars">
            <tbody>
              {entries.map(([name, value]) => (
                <VariableRow
                  key={name}
                  name={name}
                  value={value}
                  scope={frame.scopes.get(name)}
                  changed={changed.has(name)}
                  language={language}
                  store={store}
                  highlightedObject={highlightedObject}
                  onHighlightObject={onHighlightObject}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  readonly name: string;
  readonly value: Value;
  readonly scope: string | undefined;
  readonly changed: boolean;
  readonly language: Language;
  readonly store: TraceStore;
  readonly highlightedObject: number | undefined;
  readonly onHighlightObject?: (obj: number | undefined) => void;
}

function VariableRow({
  name,
  value,
  scope,
  changed,
  language,
  store,
  highlightedObject,
  onHighlightObject,
}: RowProps) {
  const state = store.state;
  const target = isRef(value) ? state.objects.get(value.ref) : undefined;
  const isHighlighted = target !== undefined && target.obj === highlightedObject;

  return (
    <tr className={`fv-var${changed ? " is-changed" : ""}${isHighlighted ? " is-linked" : ""}`}>
      <td className="fv-var-name">
        {name}
        {scope === "param" ? <span className="fv-badge">param</span> : null}
      </td>
      <td
        className="fv-var-value"
        onMouseEnter={() => target && onHighlightObject?.(target.obj)}
        onMouseLeave={() => target && onHighlightObject?.(undefined)}
      >
        {target ? (
          <button
            type="button"
            className="fv-ref-chip"
            title={`heap object #${target.obj}${
              target.shape ? ` — inferred ${shapeLabel(target.shape)}` : ""
            }`}
            onClick={() => store.seekChange({ kind: "object", obj: target.obj }, 1)}
          >
            {formatValue(value, { language, state })}
          </button>
        ) : (
          <span>{formatValue(value, { language, state })}</span>
        )}
        {changed ? (
          <span className="fv-changed-marker" title="changed at this step">
            <ChangedIcon />
            <span className="fv-sr-only">changed at this step</span>
          </span>
        ) : null}
      </td>
      <td className="fv-var-type fv-muted">{typeOfValue(value, { language, state })}</td>
    </tr>
  );
}
