/**
 * The call stack, innermost first.
 *
 * Frames that have returned are kept and shown dimmed rather than vanishing, because "what did that
 * call return?" is a question people ask immediately after it returns, and a stack that erases its
 * own history cannot answer it.
 */

import type { Language } from "@flow-view/trace-schema";
import type { FrameLive, TraceStore } from "@flow-view/trace-store";
import { activeFrames, focusFrame } from "@flow-view/trace-store";

import { formatValue } from "./format.js";
import { useTraceVersion } from "./useStore.js";

export interface StackPaneProps {
  readonly store: TraceStore;
  readonly language: Language;
  readonly onSelectFrame?: (frame: FrameLive) => void;
}

/**
 * Label for the stack's state.
 *
 * "finished" and "not started" look identical if you only check whether frames are active — both
 * have none — so the run status decides which it is.
 */
function describeDepth(
  depth: number,
  status: TraceStore["state"]["status"],
  focus: FrameLive | undefined,
): string {
  if (depth > 0) return `depth ${depth}`;
  if (status !== undefined) return "finished";
  return focus ? "returned" : "not started";
}

export function StackPane({ store, language, onSelectFrame }: StackPaneProps) {
  useTraceVersion(store);
  const state = store.state;
  const frames = activeFrames(state);
  const focus = focusFrame(state);

  // When nothing is running, show the frame that returned last so the pane is not empty at the
  // exact moment the user wants to read the result.
  const shown = frames.length > 0 ? frames : focus ? [focus] : [];

  return (
    <div className="fv-pane">
      <div className="fv-pane-title">
        <span>Call stack</span>
        <span className="fv-muted">{describeDepth(frames.length, state.status, focus)}</span>
      </div>
      <div className="fv-pane-body">
        {shown.length === 0 ? (
          <p className="fv-empty">Nothing on the stack yet.</p>
        ) : (
          <ol className="fv-frames">
            {shown.map((frame) => (
              <li
                key={frame.frame}
                className={`fv-frame${frame.active ? "" : " is-returned"}${
                  frame === focus ? " is-focus" : ""
                }`}
                onClick={() => onSelectFrame?.(frame)}
              >
                <div className="fv-frame-head">
                  <span className="fv-frame-name">{frame.func}</span>
                  <span className="fv-frame-args">
                    (
                    {frame.args
                      .map((a) => `${a.name}=${formatValue(a.value, { language, state })}`)
                      .join(", ")}
                    )
                  </span>
                  {frame.recursionDepth > 0 ? (
                    <span className="fv-badge" title="recursion depth">
                      d{frame.recursionDepth}
                    </span>
                  ) : null}
                  {frame.kind === "library" ? (
                    <span className="fv-badge is-library" title="library call, not stepped into">
                      lib
                    </span>
                  ) : null}
                </div>
                <div className="fv-frame-meta">
                  <span className="fv-muted">line {frame.line}</span>
                  {frame.active ? null : frame.returnValue === undefined ? (
                    // No value was recorded, which is not the same as returning nothing. Saying
                    // "returned —" would invent a result the trace never claimed.
                    <span className="fv-muted">ended</span>
                  ) : (
                    <span className="fv-return">
                      returned {formatValue(frame.returnValue, { language, state })}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
