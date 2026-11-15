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

import { useCallback, useMemo, useRef, useState } from "react";

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
import type { Language } from "@flow-view/trace-schema";

import { Editor } from "./Editor.js";
import { RunControls } from "./RunControls.js";
import { parseSavedSession, serializeSession, sessionFileLimit } from "./traceFiles.js";
import { useLiveRun } from "./useLiveRun.js";

type Mode = "run" | "examples";

/**
 * The program each language opens with.
 *
 * The same program in every language, deliberately: recursion, a loop, a list being built. Switching
 * language should show you the same idea in a different spelling rather than a different example, so the
 * thing you are comparing is the language and not the program.
 */
const STARTERS: Partial<Record<Language, string>> = {
  python: `def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)

values = []
for i in range(1, 6):
    values.append(fact(i))

print(values)
`,
  javascript: `function fact(n) {
  if (n <= 1) {
    return 1;
  }
  return n * fact(n - 1);
}

const values = [];
for (let i = 1; i < 6; i++) {
  values.push(fact(i));
}

console.log(values);
`,
};

const FALLBACK_STARTER = "";

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
  const [language, setLanguage] = useState<Language>("python");
  const [source, setSource] = useState(STARTERS.python ?? FALLBACK_STARTER);
  const [stdin, setStdin] = useState("");
  const [recordedSource, setRecordedSource] = useState("");
  const [sessionError, setSessionError] = useState<string | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);

  // The language of the trace being *shown*, which is not necessarily the one selected: switching the
  // selector while a JavaScript run is on screen must not relabel it as Python and re-highlight it with the
  // wrong grammar. The trace says what it is.
  const tracedLanguage = (live.store.getSession()?.language as Language | undefined) ?? language;

  /**
   * Switching language replaces the program, but only when it has not been touched.
   *
   * Discarding someone's work because they browsed the dropdown would be unforgivable; leaving Python source
   * in the box after choosing JavaScript is merely unhelpful. So the starter is swapped when the editor still
   * holds a starter, and left alone otherwise.
   */
  const chooseLanguage = useCallback(
    (next: Language) => {
      setLanguage(next);
      const starters = Object.values(STARTERS);
      if (starters.includes(source)) {
        setSource(STARTERS[next] ?? FALLBACK_STARTER);
      }
    },
    [source],
  );

  // Which of the editor and the traced code occupies the left pane.
  //
  // Running used to replace the editor permanently, so after one run the only way to change the
  // program was to reload the page. Editing what you just watched is the whole loop.
  const [editing, setEditing] = useState(true);

  const run = useCallback(() => {
    setEditing(false);
    setRecordedSource(source);
    setSessionError(undefined);
    live.run({
      source,
      language,
      stdin: stdin.trim() ? stdin : undefined,
    });
  }, [live, source, language, stdin]);

  const saveSession = useCallback(() => {
    const trace = live.exportTrace();
    if (!trace) return;
    const blob = new Blob([serializeSession(trace, recordedSource)], { type: "application/json" });
    if (blob.size > sessionFileLimit()) {
      setSessionError("This session is too large to save as a 64 MB portable file.");
      return;
    }
    setSessionError(undefined);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `flow-view-${trace.session.id}.fvtrace.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [live, recordedSource]);

  const openSession = useCallback(async (file: File) => {
    try {
      if (file.size > sessionFileLimit()) throw new Error("The session exceeds the 64 MB import limit.");
      const saved = await parseSavedSession(await file.text());
      live.importTrace(saved.trace);
      setSource(saved.source);
      setRecordedSource(saved.source);
      setLanguage(saved.trace.session.language as Language);
      setEditing(false);
      setSessionError(undefined);
      onHighlight(undefined);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : "Could not open this session.");
    }
  }, [live, onHighlight]);

  // The code pane shows the source the *running* trace belongs to, not whatever has been typed
  // since. Highlighting line 4 of a program the user has edited underneath would point at the wrong
  // code entirely.
  const tracedSource = useMemo(() => {
    if (!live.session) return source.split("\n");
    return live.store.getSession()
      ? sourceOfRun(live.store, recordedSource)
      : source.split("\n");
  }, [live.session, live.store, recordedSource, source]);

  const started = live.status !== "idle" && live.session !== undefined;
  const showingCode = started && !editing;

  return (
    <>
      <RunControls
        live={live}
        onRun={run}
        language={language}
        onLanguageChange={chooseLanguage}
        stdin={stdin}
        onStdinChange={setStdin}
        editing={editing}
        canToggleEditing={started}
        onToggleEditing={() => setEditing((value) => !value)}
      />
      <div className="fv-picker" aria-label="Session files">
        <button type="button" onClick={saveSession} disabled={!live.store.isComplete}>
          Save session
        </button>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={live.status === "running" || live.status === "starting" || live.status === "awaiting-input"}
        >
          Open session
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".json,.fvtrace"
          aria-label="Select a Flow_View session"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void openSession(file);
          }}
        />
        {sessionError ? <span role="alert" className="fv-note is-warn">{sessionError}</span> : null}
      </div>

      <main className="fv-main">
        <div className="fv-area is-code">
          {showingCode ? (
            <CodePane store={live.store} source={tracedSource} language={tracedLanguage} />
          ) : (
            <Editor
              value={source}
              language={language}
              onChange={setSource}
              onRun={run}
              disabled={live.status === "running"}
            />
          )}
        </div>
        <div className="fv-area is-stack">
          <StackPane store={live.store} language={tracedLanguage} />
        </div>
        <div className="fv-area is-vars">
          <VariablesPane
            store={live.store}
            language={tracedLanguage}
            highlightedObject={highlighted}
            onHighlightObject={onHighlight}
          />
        </div>
        <div className="fv-area is-heap">
          <HeapPane
            store={live.store}
            language={tracedLanguage}
            highlightedObject={highlighted}
            onHighlightObject={onHighlight}
          />
        </div>
        <div className="fv-area is-narration">
          <NarrationPane store={live.store} language={tracedLanguage} />
        </div>
        <div className="fv-area is-side">
          <OutputPane store={live.store} />
          <MetricsPane store={live.store} />
        </div>
        <div className="fv-area is-timeline">
          <TimelinePane store={live.store} language={tracedLanguage} />
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
