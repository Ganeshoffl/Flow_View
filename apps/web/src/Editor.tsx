/**
 * The source editor.
 *
 * CodeMirror 6, which is what design.md specified from the start and what FR-1 asks for: syntax
 * highlighting for all five languages. It was a plain textarea for four phases — good enough to paste
 * a program and press run, which is what mattered first, but leaving a stated requirement unmet while
 * the rest of the tool grew around it.
 *
 * A few things are deliberate:
 *
 * - **The highlight palette is the app's palette.** Colours come from the same CSS variables the rest
 *   of the panes use, so the editor does not look like a component from a different program.
 * - **Ctrl/Cmd+Enter runs**, because that is the shortcut every notebook and playground has trained
 *   people to expect. It is bound ahead of the default keymap so nothing else can claim it.
 * - **Tab indents rather than moving focus.** A tab key that escapes the field makes an editor useless
 *   for writing Python, which is most of what this one is for.
 * - **The editable element keeps the class `fv-editor-area`.** The browser gates drive it by that
 *   selector, and a rename would have quietly stopped them typing anywhere.
 */

import { useEffect, useRef } from "react";

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

import type { Language } from "@flow-view/trace-schema";

export interface EditorProps {
  readonly value: string;
  readonly language: Language;
  readonly onChange: (value: string) => void;
  readonly onRun: () => void;
  readonly disabled?: boolean;
}

/** All five languages FR-1 names. C and C++ share one grammar. */
function grammarFor(language: Language): Extension {
  switch (language) {
    case "python":
      return python();
    case "javascript":
      return javascript();
    case "java":
      return java();
    case "c":
    case "cpp":
      return cpp();
    default:
      return [];
  }
}

/**
 * Highlighting drawn from the app's own variables.
 *
 * Every colour here already exists elsewhere in the interface, so the editor reads as part of the same
 * tool rather than as an embedded widget with opinions of its own.
 */
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--fv-syn-keyword)" },
  { tag: [tags.controlKeyword, tags.moduleKeyword], color: "var(--fv-syn-keyword)" },
  { tag: [tags.definitionKeyword, tags.operatorKeyword], color: "var(--fv-syn-keyword)" },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName], color: "var(--fv-text)" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "var(--fv-syn-function)" },
  { tag: [tags.definition(tags.variableName)], color: "var(--fv-syn-function)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--fv-syn-type)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--fv-syn-number)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--fv-syn-string)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--fv-syn-comment)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--fv-syn-operator)" },
  { tag: tags.invalid, color: "var(--fv-warn)" },
]);

/** Layout and colours, so the editor inherits the pane it sits in. */
const theme = EditorView.theme(
  {
    "&": {
      height: "100%",
      fontSize: "13px",
      backgroundColor: "transparent",
      color: "var(--fv-text)",
    },
    ".cm-scroller": { fontFamily: "var(--fv-mono)", lineHeight: "1.55", overflow: "auto" },
    ".cm-content": { caretColor: "var(--fv-accent)", padding: "6px 0" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--fv-muted)",
      border: "none",
      paddingRight: "8px",
      userSelect: "none",
    },
    ".cm-activeLine": { backgroundColor: "var(--fv-surface-2)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fv-text)" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fv-accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--fv-accent-dim)",
    },
    ".cm-matchingBracket": {
      backgroundColor: "var(--fv-accent-dim)",
      outline: "1px solid var(--fv-accent)",
    },
  },
  { dark: true },
);

export function Editor({ value, language, onChange, onRun, disabled }: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Held in refs so the view is built once. Rebuilding it on every keystroke would lose the selection,
  // the undo history and the scroll position.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  const languageRef = useRef(new Compartment());
  const editableRef = useRef(new Compartment());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          indentOnInput(),
          highlightActiveLine(),
          indentUnit.of("    "),
          syntaxHighlighting(highlight),
          theme,
          // Ahead of the default keymap, so nothing else can claim the run shortcut.
          keymap.of([
            {
              key: "Mod-Enter",
              preventDefault: true,
              run: () => {
                onRunRef.current();
                return true;
              },
            },
          ]),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          languageRef.current.of(grammarFor(language)),
          editableRef.current.of(EditorView.editable.of(!disabled)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.contentAttributes.of({
            "aria-label": "Program source",
            spellcheck: "false",
            autocapitalize: "off",
            autocorrect: "off",
          }),
        ],
      }),
      parent: host,
    });
    // The gates drive the editor by this class, and CodeMirror owns the element.
    view.contentDOM.classList.add("fv-editor-area");
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Built once. Prop changes are pushed in through the effects below rather than by rebuilding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push an externally changed value in, without disturbing the caret when nothing actually differs.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageRef.current.reconfigure(grammarFor(language)),
    });
  }, [language]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableRef.current.reconfigure(EditorView.editable.of(!disabled)),
    });
  }, [disabled]);

  return (
    <div className="fv-pane fv-editor">
      <div className="fv-pane-title">
        <span>Your code</span>
        <span className="fv-muted">{language}</span>
      </div>
      <div className="fv-editor-body" ref={hostRef} />
    </div>
  );
}
