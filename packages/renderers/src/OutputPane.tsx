/**
 * Program output, plus whatever the run needs to tell the user.
 *
 * Output is shown only up to the playhead, which matters more than it sounds: if the whole run's
 * output appeared immediately, a user stepping through line 3 would see text that line 9 has not
 * printed yet, and would reasonably conclude the tool is lying.
 *
 * Adapter notes and a truncation reason live here too, because a run that stopped early must say so
 * somewhere the user is already looking.
 */

import type { RunStatus } from "@flow-view/trace-schema";
import type { TraceStore } from "@flow-view/trace-store";

import { useTraceVersion } from "./useStore.js";

export interface OutputPaneProps {
  readonly store: TraceStore;
}

const STATUS_EXPLANATION: Record<RunStatus, string | undefined> = {
  ok: undefined,
  error: "The program raised an exception that nothing caught.",
  timeout: "The run exceeded its time limit and was stopped.",
  step_limit: "The step budget was reached. Everything up to that point is shown.",
  memory_limit: "The run exceeded its memory limit and was stopped.",
  killed: "The run was stopped before it finished.",
};

export function OutputPane({ store }: OutputPaneProps) {
  useTraceVersion(store);
  const state = store.state;
  const chunks = state.output;
  const explanation = state.status ? STATUS_EXPLANATION[state.status] : undefined;

  return (
    <div className="fv-pane">
      <div className="fv-pane-title">
        <span>Output</span>
        {state.pendingInput ? <span className="fv-awaiting">waiting for input</span> : null}
      </div>
      <div className="fv-pane-body">
        {chunks.length === 0 && !explanation && state.notes.length === 0 ? (
          <p className="fv-empty">No output yet.</p>
        ) : null}

        {chunks.length > 0 ? (
          <pre className="fv-output">
            {chunks.map((chunk, i) => (
              <span key={`${chunk.seq}-${i}`} className={`fv-out-${chunk.stream}`}>
                {chunk.text}
              </span>
            ))}
          </pre>
        ) : null}

        {state.pendingInput ? (
          <p className="fv-prompt">
            {state.pendingInput.prompt ?? "Input requested"}
            <span className="fv-caret" />
          </p>
        ) : null}

        {explanation ? (
          <p className={`fv-note is-${state.status === "ok" ? "info" : "warn"}`}>{explanation}</p>
        ) : null}

        {state.notes.map((note, i) => (
          <p key={`${note.seq}-${i}`} className={`fv-note is-${note.level}`}>
            {note.text}
          </p>
        ))}
      </div>
    </div>
  );
}
