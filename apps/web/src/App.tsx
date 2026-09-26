/**
 * The Phase 0 shell.
 *
 * Fixtures in, full playback out. No adapter exists yet and that is the point: if the trace format
 * or the store is wrong, it shows up here, while the cost of changing them is still one package
 * rather than four language adapters.
 *
 * Phase 1 swaps the fixture picker for a real editor and a live session. Every pane below keeps
 * working unchanged, because none of them knows where a trace came from.
 */

import { useCallback, useMemo, useState } from "react";

import { FIXTURES, getFixture } from "@flow-view/trace-fixtures";
import {
  CodePane,
  MetricsPane,
  OutputPane,
  PlaybackBar,
  StackPane,
  VariablesPane,
} from "@flow-view/renderers";
import { TraceStore } from "@flow-view/trace-store";

export function App() {
  const [fixtureId, setFixtureId] = useState<string>(FIXTURES[0]?.id ?? "assignment");
  const [highlighted, setHighlighted] = useState<number | undefined>(undefined);

  const fixture = getFixture(fixtureId);

  // A fresh store per fixture. Reusing one would leave the previous trace's undo journal behind,
  // which is exactly the sort of state leak that produces a bug nobody can reproduce.
  const store = useMemo(() => {
    const created = new TraceStore();
    created.load(fixture.build());
    return created;
  }, [fixture]);

  const seekToLine = useCallback(
    (line: number) => {
      // Land on the first step that executed this line, so clicking source navigates the trace.
      for (let i = 0; i < store.eventCount; i++) {
        const event = store.eventAt(i);
        if (event?.t === "step_line" && event.line === line) {
          store.seekEvent(i + 1);
          return;
        }
      }
    },
    [store],
  );

  return (
    <div className="fv-app">
      <header className="fv-header">
        <div className="fv-logo">
          flow<span>_</span>view
        </div>
        <span className="fv-tagline">See what your code does while it runs.</span>
        <div className="fv-header-spacer" />
        <div className="fv-picker">
          <label htmlFor="fixture">Example</label>
          <select
            id="fixture"
            value={fixtureId}
            onChange={(event) => {
              setFixtureId(event.target.value);
              setHighlighted(undefined);
            }}
          >
            {FIXTURES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.title} · {f.language}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div>
        <p className="fv-fixture-summary">{fixture.summary}</p>
        <div className="fv-concepts">
          {fixture.concepts.map((concept) => (
            <span key={concept} className="fv-concept">
              {concept}
            </span>
          ))}
        </div>
        <PlaybackBar store={store} />
        <p className="fv-banner">
          <span className="fv-kbd">Left</span> <span className="fv-kbd">Right</span> step ·{" "}
          <span className="fv-kbd">Space</span> play · <span className="fv-kbd">o</span>{" "}
          <span className="fv-kbd">i</span> <span className="fv-kbd">u</span> over, into, out ·{" "}
          <span className="fv-kbd">Home</span> <span className="fv-kbd">End</span> jump to either
          end. Stepping backward replays recorded history, so your program never runs twice.
        </p>
      </div>

      <main className="fv-main">
        <CodePane
          store={store}
          source={fixture.source}
          language={fixture.language}
          onSelectLine={seekToLine}
        />
        <div className="fv-column">
          <StackPane store={store} language={fixture.language} />
          <VariablesPane
            store={store}
            language={fixture.language}
            highlightedObject={highlighted}
            onHighlightObject={setHighlighted}
          />
        </div>
        <div className="fv-column">
          <OutputPane store={store} />
          <MetricsPane store={store} />
        </div>
      </main>
    </div>
  );
}
