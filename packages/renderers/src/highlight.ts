/**
 * Syntax highlighting for code that is being *read* rather than edited.
 *
 * The editor gets highlighting from CodeMirror because CodeMirror is the editor. The code pane is not
 * an editor — it is a list of lines with execution state attached, and it has to stay that way: the
 * active line, the visited lines, the click-to-seek and the gates that read `.fv-code-line` all depend
 * on that structure. So rather than mounting a second editor to display text, the same Lezer grammars
 * are used directly to produce tokens, which the pane renders as spans inside the markup it already
 * has.
 *
 * The result is that both places showing code agree about what a keyword looks like, without the view
 * that cannot be an editor pretending to be one.
 *
 * Class names come from Lezer's own `classHighlighter` (`tok-keyword`, `tok-string`, ...) so the
 * palette lives in CSS with every other colour, next to the variables the editor theme uses.
 */

import type { Language } from "@flow-view/trace-schema";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import type { Parser } from "@lezer/common";
import { classHighlighter, highlightCode } from "@lezer/highlight";

/** One run of characters that share a style. `cls` is empty for ordinary text. */
export interface Token {
  readonly text: string;
  readonly cls: string;
}

function parserFor(language: Language): Parser | undefined {
  switch (language) {
    case "python":
      return python().language.parser;
    case "javascript":
      return javascript().language.parser;
    case "java":
      return java().language.parser;
    case "c":
    case "cpp":
      return cpp().language.parser;
    default:
      return undefined;
  }
}

/**
 * Anything longer than this is shown unhighlighted.
 *
 * Parsing is fast but not free, and a pasted file of tens of thousands of lines would pay for it on
 * every render. Beyond this size the pane stays useful and merely plain, which is a better failure
 * than a pane that stutters.
 */
const MAX_CHARS = 200_000;

interface Cached {
  readonly source: string;
  readonly language: Language;
  readonly lines: Token[][];
}

// One entry, because the code pane shows one program at a time and re-renders on every step. Without
// it, every step of every run would reparse the whole source.
let cached: Cached | undefined;

/**
 * Tokenise a program, one array of tokens per line.
 *
 * Returns a single unstyled token per line when the language has no grammar or the source is too
 * large, so callers never have to special-case the result.
 */
export function highlightLines(source: string, language: Language): Token[][] {
  if (cached && cached.source === source && cached.language === language) return cached.lines;

  const lines = source.split("\n");
  const parser = parserFor(language);
  if (!parser || source.length > MAX_CHARS) {
    const plain = lines.map((text) => [{ text, cls: "" }]);
    cached = { source, language, lines: plain };
    return plain;
  }

  // Build up per-line tokens as the highlighter walks the document in order.
  const out: Token[][] = lines.map(() => []);
  let line = 0;
  const push = (text: string, cls: string) => {
    // A token can contain newlines — a docstring, a block comment — so it is split across the lines it
    // covers. Without this, a triple-quoted string would push everything after it onto one line.
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) line += 1;
      const part = parts[i] ?? "";
      if (part.length > 0 && out[line]) out[line]!.push({ text: part, cls });
    }
  };

  try {
    highlightCode(
      source,
      parser.parse(source),
      classHighlighter,
      (text, cls) => push(text, cls),
      () => {
        // The highlighter reports line breaks separately from token text. Both paths advance the line,
        // and `push` already advanced for breaks inside a token, so only bare breaks land here.
        line += 1;
      },
    );
  } catch {
    // A grammar that throws on strange input must not take the pane with it. Showing the program
    // unhighlighted is a real answer; showing nothing is not.
    const plain = lines.map((text) => [{ text, cls: "" }]);
    cached = { source, language, lines: plain };
    return plain;
  }

  // Blank lines and any line the highlighter skipped still need something to render.
  for (let i = 0; i < out.length; i++) {
    if (!out[i] || out[i]!.length === 0) out[i] = [{ text: lines[i] ?? "", cls: "" }];
  }

  cached = { source, language, lines: out };
  return out;
}
