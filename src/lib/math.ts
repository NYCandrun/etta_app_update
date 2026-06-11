import katex from "katex";
import DOMPurify from "dompurify";

// Pure (component-free) math tokenizer + renderer shared by the RichText
// surface. Kept out of the .tsx so the component file only exports components
// (react-refresh) and so tests can target the rendering logic directly.
//
// Math: every `$...$` (inline) and `$$...$$` (block) span is rendered by KaTeX
// with `output: "htmlAndMathml"` so screen readers get real MathML — we NEVER
// expose raw LaTeX as text or as an aria-label. On a KaTeX failure we return
// null so the caller shows the "Math display error" sentinel, never raw LaTeX.
//
// Sanitization: KaTeX HTML is the only HTML injected, run through DOMPurify
// (MathML profile enabled) before any dangerouslySetInnerHTML.

export const MATH_ERROR = "Math display error";

export interface Segment {
  kind: "text" | "math";
  value: string;
  display: boolean; // block math when true
}

// Split on $$...$$ (block) first, then $...$ (inline). A backslash-escaped
// \$ is treated as a literal dollar sign, not a delimiter.
export function tokenize(input: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  let buf = "";

  const flushText = () => {
    if (buf.length > 0) {
      segments.push({ kind: "text", value: buf, display: false });
      buf = "";
    }
  };

  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\" && i + 1 < input.length && input[i + 1] === "$") {
      buf += "$";
      i += 2;
      continue;
    }
    if (ch === "$") {
      const isBlock = input[i + 1] === "$";
      const delim = isBlock ? "$$" : "$";
      const start = i + delim.length;
      const end = findClosing(input, start, delim);
      if (end === -1) {
        // Unterminated delimiter: treat the rest as literal text.
        buf += input.slice(i);
        break;
      }
      flushText();
      segments.push({
        kind: "math",
        value: input.slice(start, end),
        display: isBlock,
      });
      i = end + delim.length;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flushText();
  return segments;
}

// Find the next unescaped closing delimiter at or after `from`.
function findClosing(input: string, from: number, delim: string): number {
  let i = from;
  while (i < input.length) {
    if (input[i] === "\\") {
      i += 2;
      continue;
    }
    if (input.startsWith(delim, i)) {
      return i;
    }
    i += 1;
  }
  return -1;
}

// Render one math span to sanitized KaTeX HTML, or null on failure (so the
// caller shows the error sentinel — never the raw LaTeX).
export function renderMath(latex: string, display: boolean): string | null {
  try {
    const raw = katex.renderToString(latex, {
      displayMode: display,
      throwOnError: true,
      output: "htmlAndMathml",
    });
    return DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
    });
  } catch {
    return null;
  }
}
