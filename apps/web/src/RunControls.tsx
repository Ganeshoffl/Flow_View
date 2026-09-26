/**
 * Run, stop, playback, and everything the run needs to tell the user.
 *
 * Three things here are about honesty rather than convenience: a server that is not running says so
 * with the command that starts it, the guards actually protecting a run are named, and a blocking
 * read is shown as a question the program is waiting on rather than as a stalled screen.
 */

import { useCallback, useState } from "react";

import { PlaybackBar } from "@flow-view/renderers";

import type { LiveRun } from "./useLiveRun.js";

export interface RunControlsProps {
  readonly live: LiveRun;
  readonly onRun: () => void;
  readonly stdin: string;
  readonly onStdinChange: (value: string) => void;
}

export function RunControls({ live, onRun, stdin, onStdinChange }: RunControlsProps) {
  const [answer, setAnswer] = useState("");
  const [showStdin, setShowStdin] = useState(false);

  const busy = live.status === "running" || live.status === "starting";
  const started = live.session !== undefined;

  const submit = useCallback(() => {
    live.answer(answer);
    setAnswer("");
  }, [answer, live]);

  const python = live.capabilities?.languages.find((l) => l.language === "python");

  return (
    <div className="fv-runbar">
      <div className="fv-runbar-row">
        <button type="button" className="is-primary fv-run" onClick={onRun} disabled={busy}>
          {busy ? "Running…" : started ? "Run again" : "Run"}
        </button>
        {busy ? (
          <button type="button" onClick={live.stop}>
            Stop
          </button>
        ) : null}

        <span className={`fv-status is-${live.status}`}>{describeStatus(live.status)}</span>

        <button
          type="button"
          className="fv-toggle"
          aria-expanded={showStdin}
          onClick={() => setShowStdin((value) => !value)}
          title="Supply input up front, so the run replays without anyone typing"
        >
          Input {stdin.trim() ? "•" : ""}
        </button>

        {started ? (
          <label className="fv-follow">
            <input
              type="checkbox"
              checked={live.following}
              onChange={(event) => live.setFollowing(event.target.checked)}
            />
            follow live
          </label>
        ) : null}

        <div className="fv-header-spacer" />

        {python?.version ? (
          <span className="fv-muted fv-runtime">python {python.version}</span>
        ) : null}
      </div>

      {showStdin ? (
        <label className="fv-stdin-prefill">
          <span className="fv-muted">
            Input for the program, one value per line. Supplied up front, the whole trace can be
            scrubbed without anyone typing.
          </span>
          <textarea
            value={stdin}
            rows={3}
            spellCheck={false}
            onChange={(event) => onStdinChange(event.target.value)}
            placeholder={"Ada\n36"}
          />
        </label>
      ) : null}

      {live.prompt ? (
        <div className="fv-ask">
          <span className="fv-ask-prompt">{live.prompt}</span>
          <input
            autoFocus
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            aria-label="Answer the program's request for input"
          />
          <button type="button" className="is-primary" onClick={submit}>
            Send
          </button>
        </div>
      ) : null}

      {live.error ? (
        <div className="fv-note is-warn">
          <strong>{live.error.message}</strong>
          {live.error.detail ? <pre className="fv-error-detail">{live.error.detail}</pre> : null}
        </div>
      ) : null}

      {started ? <PlaybackBar store={live.store} /> : null}

      {started && live.session?.guards_active?.length ? (
        <p className="fv-guards fv-muted">
          Protecting this run: {live.session.guards_active.join(" · ")}
        </p>
      ) : null}

      {live.capabilities?.inactive_guards?.length ? (
        <p className="fv-guards fv-muted">
          Not available on this platform: {live.capabilities.inactive_guards.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function describeStatus(status: LiveRun["status"]): string {
  switch (status) {
    case "idle":
      return "ready";
    case "starting":
      return "starting the tracer";
    case "running":
      return "running";
    case "awaiting-input":
      return "waiting for input";
    case "complete":
      return "finished";
    case "error":
      return "failed";
    default:
      return status;
  }
}
