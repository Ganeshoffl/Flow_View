/**
 * Playback: step, back-step, play, scrub.
 *
 * Backward stepping is a first-class control sitting next to forward, not a hidden affordance,
 * because it is the single thing that makes a visualizer more useful than a print statement. It
 * costs nothing to offer: the store replays recorded history rather than re-running the program.
 *
 * Every control has a keyboard binding, and the whole bar is reachable by tab.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { TraceStore } from "@flow-view/trace-store";

import { formatMs } from "./format.js";
import {
  PauseIcon,
  PlayIcon,
  SkipEndIcon,
  SkipStartIcon,
  StepBackIcon,
  StepForwardIcon,
} from "./icons.js";
import { useTraceVersion } from "./useStore.js";

export interface PlaybackBarProps {
  readonly store: TraceStore;
  /** Steps per second while playing. */
  readonly defaultSpeed?: number;
}

const SPEEDS = [1, 2, 4, 8, 16, 32] as const;

export function PlaybackBar({ store, defaultSpeed = 4 }: PlaybackBarProps) {
  useTraceVersion(store);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(defaultSpeed);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    setPlaying(false);
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    if (!playing) return;
    const interval = setInterval(() => {
      // Playback halts at the end, and at a blocking read: advancing past a prompt the user has not
      // answered would be asserting an input they never gave.
      if (!store.next() || store.state.pendingInput) stop();
    }, 1000 / speed);
    timer.current = interval;
    return () => clearInterval(interval);
  }, [playing, speed, store, stop]);

  const act = useCallback(
    (fn: () => void) => {
      stop();
      fn();
    },
    [stop],
  );

  // Keyboard control of the whole transport. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      switch (event.key) {
        case "ArrowRight":
        case "n":
          event.preventDefault();
          act(() => store.next());
          break;
        case "ArrowLeft":
        case "p":
          event.preventDefault();
          act(() => store.prev());
          break;
        case " ":
          event.preventDefault();
          setPlaying((value) => !value);
          break;
        case "Home":
          event.preventDefault();
          act(() => store.rewind());
          break;
        case "End":
          event.preventDefault();
          act(() => store.fastForward());
          break;
        case "o":
          event.preventDefault();
          act(() => store.stepOver());
          break;
        case "i":
          event.preventDefault();
          act(() => store.stepInto());
          break;
        case "u":
          event.preventDefault();
          act(() => store.stepOut());
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, store]);

  const step = Math.max(0, store.state.step);
  const total = Math.max(0, store.stepCount - 1);

  return (
    <div className="fv-playback">
      <div className="fv-transport">
        <button
          type="button"
          onClick={() => act(() => store.rewind())}
          title="Rewind to the start (Home)"
          aria-label="Rewind to the start"
        >
          <SkipStartIcon />
        </button>
        <button
          type="button"
          onClick={() => act(() => store.prev())}
          disabled={store.isAtStart}
          title="Step backward (Left arrow, or p)"
        >
          <StepBackIcon /> Back
        </button>
        <button
          type="button"
          className="is-primary"
          onClick={() => setPlaying((value) => !value)}
          title="Play or pause (space)"
        >
          {playing ? <PauseIcon /> : <PlayIcon />} {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          onClick={() => act(() => store.next())}
          disabled={store.isAtEnd}
          title="Step forward (Right arrow, or n)"
        >
          Step <StepForwardIcon />
        </button>
        <button
          type="button"
          onClick={() => act(() => store.fastForward())}
          title="Jump to the end (End)"
          aria-label="Jump to the end"
        >
          <SkipEndIcon />
        </button>
      </div>

      <div className="fv-transport fv-transport-frames">
        <button type="button" onClick={() => act(() => store.stepOver())} title="Step over (o)">
          Over
        </button>
        <button type="button" onClick={() => act(() => store.stepInto())} title="Step into (i)">
          Into
        </button>
        <button type="button" onClick={() => act(() => store.stepOut())} title="Step out (u)">
          Out
        </button>
      </div>

      <label className="fv-scrub">
        <input
          type="range"
          min={0}
          max={total}
          value={Math.min(step, total)}
          onChange={(event) => act(() => store.seekStep(Number(event.target.value)))}
          aria-label="Position in the trace"
        />
        <span className="fv-position">
          step {step} / {total}
        </span>
      </label>

      <label className="fv-speed">
        speed
        <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
          {SPEEDS.map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
      </label>

      <span className="fv-clock fv-muted" title="elapsed program time">
        {formatMs(store.state.ms)}
      </span>
    </div>
  );
}
