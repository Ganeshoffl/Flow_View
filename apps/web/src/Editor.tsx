/**
 * The source editor.
 *
 * A textarea with a line-number gutter and tab handling. Deliberately minimal for now: CodeMirror 6
 * is the documented choice and brings syntax highlighting and inline error markers, and swapping it
 * in touches only this file. What matters first is that a user can paste a program and run it, and
 * the editor is not what makes that interesting.
 *
 * Tab inserts four spaces rather than moving focus, because this is Python and a tab key that
 * escapes the field makes the editor unusable for its actual purpose. Shift-Tab dedents.
 */

import { useCallback, useMemo, useRef } from "react";

import type { Language } from "@flow-view/trace-schema";

export interface EditorProps {
  readonly value: string;
  readonly language: Language;
  readonly onChange: (value: string) => void;
  readonly onRun: () => void;
  readonly disabled?: boolean;
}

const INDENT = "    ";

export function Editor({ value, language, onChange, onRun, disabled }: EditorProps) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const lineCount = useMemo(() => Math.max(1, value.split("\n").length), [value]);

  const handleKey = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const area = event.currentTarget;

      // Ctrl/Cmd+Enter runs, which is the shortcut people already expect from every notebook and
      // playground they have used.
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        onRun();
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        const { selectionStart, selectionEnd } = area;

        if (event.shiftKey) {
          const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
          if (value.startsWith(INDENT, lineStart)) {
            const next = value.slice(0, lineStart) + value.slice(lineStart + INDENT.length);
            onChange(next);
            requestAnimationFrame(() => {
              area.selectionStart = area.selectionEnd = Math.max(
                lineStart,
                selectionStart - INDENT.length,
              );
            });
          }
          return;
        }

        const next = value.slice(0, selectionStart) + INDENT + value.slice(selectionEnd);
        onChange(next);
        requestAnimationFrame(() => {
          area.selectionStart = area.selectionEnd = selectionStart + INDENT.length;
        });
        return;
      }

      if (event.key === "Enter") {
        // Keep the current indentation, and add a level after a colon. Without this, writing a loop
        // in a plain textarea means re-typing the indent on every line.
        const lineStart = value.lastIndexOf("\n", area.selectionStart - 1) + 1;
        const currentLine = value.slice(lineStart, area.selectionStart);
        const indent = /^[ \t]*/.exec(currentLine)?.[0] ?? "";
        const deeper = /:\s*$/.test(currentLine) ? INDENT : "";
        if (!indent && !deeper) return;

        event.preventDefault();
        const insertion = `\n${indent}${deeper}`;
        const next =
          value.slice(0, area.selectionStart) + insertion + value.slice(area.selectionEnd);
        const caret = area.selectionStart + insertion.length;
        onChange(next);
        requestAnimationFrame(() => {
          area.selectionStart = area.selectionEnd = caret;
        });
      }
    },
    [onChange, onRun, value],
  );

  return (
    <div className="fv-pane fv-editor">
      <div className="fv-pane-title">
        <span>Your code</span>
        <span className="fv-muted">{language}</span>
      </div>
      <div className="fv-editor-body">
        <div className="fv-editor-gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
        <textarea
          ref={areaRef}
          className="fv-editor-area"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          aria-label="Program source"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKey}
        />
      </div>
    </div>
  );
}
