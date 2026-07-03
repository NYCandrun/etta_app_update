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
//
// Currency guard: bare dollar amounts in word problems ("You have $5 and earn
// $3") must stay literal text, so an INLINE span only opens when all of these
// hold (Pandoc-style rules):
//   - the char after the opening $ is non-space,
//   - the closing $ is the VERY NEXT unescaped $ (math content never contains
//     a bare $), on the SAME line,
//   - the char before the closing $ is non-space,
//   - the closing $ is not immediately followed by a digit ("$5-$10").
// A $ that fails these rules is literal text and scanning continues after it,
// so a later well-formed span still renders ("You have $5 and $x$" keeps the
// $5 literal but typesets x). Block $$...$$ keeps the original greedy
// multi-line behavior.
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
      if (isBlock) {
        const start = i + 2;
        const end = findClosing(input, start, "$$");
        if (end === -1) {
          // Unterminated block delimiter: rest is literal text (streaming-safe).
          buf += input.slice(i);
          break;
        }
        flushText();
        segments.push({ kind: "math", value: input.slice(start, end), display: true });
        i = end + 2;
        continue;
      }
      // Inline span: validate the currency rules against the NEXT unescaped $.
      const start = i + 1;
      const after = input[start];
      const openOk = after !== undefined && !/\s/.test(after);
      const end = openOk ? findClosing(input, start, "$") : -1;
      const content = end === -1 ? "" : input.slice(start, end);
      const closeOk =
        end !== -1 &&
        end > start &&
        !content.includes("\n") &&
        !/\s/.test(input[end - 1] ?? "") &&
        !/[0-9]/.test(input[end + 1] ?? "");
      if (!closeOk) {
        // Not a math span (currency, unterminated, or cross-line): this $ is
        // literal; keep scanning so later valid spans still render.
        buf += "$";
        i += 1;
        continue;
      }
      flushText();
      segments.push({ kind: "math", value: content, display: false });
      i = end + 1;
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
