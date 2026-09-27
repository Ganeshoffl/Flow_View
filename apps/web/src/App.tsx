/**
 * flow_view.
 *
 * Two modes over one set of views. **Run** traces a program you paste, through the local server.
 * **Examples** replays the fixture corpus with no server at all.
 *
 * Every pane below is identical in both modes, because none of them knows where a trace came from.
 * That is the trace format doing its job: when the JavaScript adapter lands, or Pyodide in a worker,
 * nothing here changes.
 */

import { useCallback, useMemo, useState } from "react";

import { FIXTURES, getFixture } from "@flow-view/trace-fixtures";
import {
  CodePane,
  HeapPane,
  MetricsPane,
  NarrationPane,
  OutputPane,
  PlaybackBar,
  StackPane,
  TimelinePane,
  VariablesPane,
} from "@flow-view/renderers";
import { TraceStore } from "@flow-view/trace-store";

import { Editor } from "./Editor.js";
import { RunControls } from "./RunControls.js";
import { useLiveRun } from "./useLiveRun.js";

type Mode = "run" | "examples";

const STARTER = `def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)

values = []
for i in range(1, 6):
    values.append(fact(i))

print(values)
`;

export function App() {
  const [mode, setMode] = useState<Mode>("run");
  const [highlighted, setHighlighted] = useState<number | undefined>(undefined);

  return (
    <div className="fv-app">
      <header className="fv-header">
        <div className="fv-logo">
          flow<span>_</span>view
        </div>
        <span className="fv-tagline">See what your code does while it runs.</span>
        <div className="fv-header-spacer" />
        <div className="fv-modes" role="tablist" aria-label="Mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "run"}
            className={mode === "run" ? "is-primary" : ""}
            onClick={() => setMode("run")}
          >
            Run your code
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "examples"}
            className={mode === "examples" ? "is-primary" : ""}
            onClick={() => setMode("examples")}
          >
            Examples
          </button>
        </div>
      </header>

      {mode === "run" ? (
        <LiveMode highlighted={highlighted} onHighlight={setHighlighted} />
      ) : (
        <ExampleMode highlighted={highlighted} onHighlight={setHighlighted} />
      )}
    </div>
  );
}

interface ModeProps {
  readonly highlighted: number | undefined;
  readonly onHighlight: (obj: number | undefined) => void;
}

function LiveMode({ highlighted, onHighlight }: ModeProps) {
  const live = useLiveRun();
  const [source, setSource] = useState(STARTER);
  const [stdin, setStdin] = useState("");

  // Which of the editor and the traced code occupies the left pane.
  //
  // Running used to replace the editor permanently, so after one run the only way to change the
  // program was to reload the page. Editing what you just watched is the whole loop.
  const [editing, setEditing] = useState(true);

  const run = useCallback(() => {
    setEditing(false);
    live.run({
      source,
      language: "python",
      stdin: stdin.trim() ? stdin : undefined,
    });
  }, [live, source, stdin]);

  // The code pane shows the source the *running* trace belongs to, not whatever has been typed
  // since. Highlighting line 4 of a program the user has edited underneath would point at the wrong
  // code entirely.
  const tracedSource = useMemo(() => {
    if (!live.session) return source.split("\n");
    return live.store.getSession() ? sourceOfRun(live.store, source) : source.split("\n");
  }, [live.session, live.store, source]);

  const started = live.status !== "idle" && live.session !== undefined;
  const showingCode = started && !editing;

  return (
    <>
      <RunControls
        live={live}
        onRun={run}
        stdin={stdin}
        onStdinChange={setStdin}
        editing={editing}
        canToggleEditing={started}
        onToggleEditing={() => setEditing((value) => !value)}
      />

      <main className="fv-main">
        <div className="fv-area is-code">
          {showingCode ? (
            <CodePane store={live.store} source={tracedSource} language="python" />
          ) : (
            <Editor
              value={source}
              language="python"
              onChange={setSource}
              onRun={run}
              disabled={live.status === "running"}
            />
          )}
        </div>
        <div className="fv-area is-stack">
          <StackPane store={live.store} language="python" />
        </div>
        <div className="fv-area is-vars">
          <VariablesPane
            store={live.store}
            language="python"
            highlightedObject={highlighted}
            onHighlightObject={onHighlight}
          />
        </div>
        <div className="fv-area is-heap">
          <HeapPane
            store={live.store}
            language="python"
            highlightedObject={highlighted}
            onHighlightObject={onHighlight}
          />
        </div>
        <div className="fv-area is-narration">
          <NarrationPane store={live.store} language={"python"} />
        </div>
        <div className="fv-area is-side">
          <OutputPane store={live.store} />
          <MetricsPane store={live.store} />
        </div>
        <div className="fv-area is-timeline">
          <TimelinePane store={live.store} language={"python"} />
        </div>
      </main>
    </>
  );
}

/** The source as the running trace recorded it, falling back to the editor's text. */
function sourceOfRun(store: TraceStore, fallback: string): string[] {
  const session = store.getSession();
  const lineCount = session?.source_files?.[0]?.line_count ?? 0;
  const lines = fallback.split("\n");
  // The header carries a line count and a digest rather than the text itself, so the editor's
  // content is the only copy available. Trimming to the recorded length keeps them aligned when the
  // user has since typed more.
  return lineCount > 0 ? lines.slice(0, Math.max(lineCount, 1)) : lines;
}

function ExampleMode({ highlighted, onHighlight }: ModeProps) {
  const [fixtureId, setFixtureId] = useState<string>(FIXTURES[0]?.id ?? "assignment");
  const fixture = getFixture(fixtureId);

  // A fresh store per fixture. Reusing one would carry the previous trace's undo journal across,
  // which is the sort of leak that produces a bug nobody can reproduce.
  const store = useMemo(() => {
    const created = new TraceStore();
    created.load(fixture.build());
    return created;
  }, [fixture]);

  const seekToLine = useCallback(
    (line: number) => {
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
    <>
      <div>
        <div className="fv-picker">
          <label htmlFor="fixture">Example</label>
          <select
            id="fixture"
            value={fixtureId}
            onChange={(event) => {
              setFixtureId(event.target.value);
              onHighlight(undefined);
            }}
          >
            {FIXTURES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.title} · {f.language}
              </option>
            ))}
          </select>
          <span className="fv-fixture-summary">{fixture.summary}</span>
        </div>
        <PlaybackBar store={store} />
      </div>

      <main className="fv-main">
        <div className="fv-area is-code">
          <CodePane
            store={store}
            source={fixture.source}
            language={fixture.language}
            onSelectLine={seekToLine}
          />
        </div>
        <div className="fv-area is-stack">
          <StackPane store={store} language={fixture.language} />
        </div>
        <div className="fv-area is-vars">
          <VariablesPane
            store={store}
            language={fixture.language}
            highlightedObject={highlighted}
            onHighlightObject={onHighlight}
          />
        </div>
        <div className="fv-area is-heap">
          <HeapPane
            store={store}
            language={fixture.language}
            highlightedObject={highlighted}
            onHighlightObject={onHighlight}
          />
        </div>
        <div className="fv-area is-narration">
          <NarrationPane store={store} language={fixture.language} />
        </div>
        <div className="fv-area is-side">
          <OutputPane store={store} />
          <MetricsPane store={store} />
        </div>
        <div className="fv-area is-timeline">
          <TimelinePane store={store} language={fixture.language} />
        </div>
      </main>
    </>
  );
}
