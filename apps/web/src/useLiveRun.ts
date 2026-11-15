/**
 * Driving one live run.
 *
 * Owns the engine, a TraceStore, and the status the UI reads. Events are appended as they arrive but
 * the playhead is *not* moved with them, except while following the live edge: a user who paused at
 * step 12 to look at something should not be yanked to step 500 because more events landed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SCHEMA_ID, type Session, type Trace, type TraceEvent } from "@flow-view/trace-schema";
import { TraceStore } from "@flow-view/trace-store";

import { ServerEngine } from "./engine/serverEngine.js";
import type { Capabilities, RunOptions, RunStatus } from "./engine/types.js";

export interface LiveRun {
  readonly store: TraceStore;
  readonly status: RunStatus;
  readonly session: Session | undefined;
  readonly error: { message: string; detail?: string } | undefined;
  readonly capabilities: Capabilities | undefined;
  readonly prompt: string | undefined;
  /** True while the playhead advances with incoming events. */
  readonly following: boolean;
  setFollowing: (following: boolean) => void;
  run: (options: RunOptions) => void;
  importTrace: (trace: Trace) => void;
  exportTrace: () => Trace | undefined;
  answer: (text: string) => void;
  stop: () => void;
}

export function useLiveRun(): LiveRun {
  const engine = useMemo(() => new ServerEngine(), []);
  const store = useMemo(() => new TraceStore(), []);

  const [status, setStatus] = useState<RunStatus>("idle");
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [error, setError] = useState<{ message: string; detail?: string } | undefined>(undefined);
  const [capabilities, setCapabilities] = useState<Capabilities | undefined>(undefined);
  const [prompt, setPrompt] = useState<string | undefined>(undefined);
  const [following, setFollowing] = useState(true);

  const followingRef = useRef(following);
  followingRef.current = following;

  useEffect(() => {
    let cancelled = false;
    engine
      .capabilities()
      .then((value) => {
        if (!cancelled) setCapabilities(value);
      })
      .catch(() => {
        // Not fatal. The UI shows what it knows and the run itself reports a missing server far more
        // clearly than a failed probe at load time would.
      });
    return () => {
      cancelled = true;
    };
  }, [engine]);

  useEffect(() => () => engine.dispose(), [engine]);

  const run = useCallback(
    (options: RunOptions) => {
      setError(undefined);
      setSession(undefined);
      setPrompt(undefined);
      setFollowing(true);
      store.clear();

      void engine.run(options, {
        onSession: (incoming) => {
          setSession(incoming);
          store.setSession(incoming);
        },
        onEvents: (events: readonly TraceEvent[]) => {
          store.append(events);
          for (const event of events) {
            if (event.t === "stdin_request") setPrompt(event.prompt ?? "Input requested");
            else if (event.t === "stdin_response") setPrompt(undefined);
          }
          if (followingRef.current) store.fastForward();
        },
        onStatus: setStatus,
        onError: (message, detail) => setError({ message, detail }),
      });
    },
    [engine, store],
  );

  const importTrace = useCallback(
    (trace: Trace) => {
      // Import is only exposed while a live run is idle or finished. No adapter is contacted here:
      // playback of a saved run must never execute its source a second time.
      store.load(trace);
      setSession(trace.session);
      setStatus("complete");
      setPrompt(undefined);
      setError(undefined);
      setFollowing(false);
    },
    [store],
  );

  const exportTrace = useCallback((): Trace | undefined => {
    const header = store.getSession();
    if (!header || !store.isComplete) return undefined;
    return { schema: SCHEMA_ID, session: header, events: [...store.allEvents()] };
  }, [store]);

  const answer = useCallback(
    (text: string) => {
      engine.sendStdin(text);
      setPrompt(undefined);
    },
    [engine],
  );

  const stop = useCallback(() => engine.stop(), [engine]);

  return {
    store,
    status,
    session,
    error,
    capabilities,
    prompt,
    following,
    setFollowing,
    run,
    importTrace,
    exportTrace,
    answer,
    stop,
  };
}
