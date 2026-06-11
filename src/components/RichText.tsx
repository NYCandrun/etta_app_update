import { useMemo } from "react";
import "katex/dist/katex.min.css";
import { MATH_ERROR, renderMath, tokenize } from "../lib/math";

// ONE shared math/markdown renderer for lessons, quiz prompts, explanations, and
// feedback (blocklist: a single RichText surface, never per-screen variants).
// The tokenizer/renderer live in `../lib/math`; this file is the component shell.
//
// Math: every `$...$` (inline) and `$$...$$` (block) span is rendered by KaTeX
// with MathML so screen readers get real MathML — we NEVER expose raw LaTeX as
// text or as an aria-label. KaTeX HTML is sanitized with DOMPurify before
// `dangerouslySetInnerHTML`. Prose between math spans is rendered as PLAIN TEXT
// React nodes (no HTML injection), so untrusted model output cannot inject markup.

export interface RichTextProps {
  content: string;
  className?: string;
}

// Inline/block math node. On a KaTeX failure we show "Math display error" as
// real text (never the raw LaTeX, never as an aria-label).
function MathSpan({ latex, display }: { latex: string; display: boolean }) {
  const html = useMemo(() => renderMath(latex, display), [latex, display]);
  if (html === null) {
    return (
      <span role="img" aria-label={MATH_ERROR} className="text-danger">
        {MATH_ERROR}
      </span>
    );
  }
  const Tag = display ? "div" : "span";
  return <Tag dangerouslySetInnerHTML={{ __html: html }} />;
}

// The shared renderer. Prose is plain text (paragraph-split on blank lines);
// math is delegated to <MathSpan>. We intentionally do NOT run a full markdown
// parser here — lessons use `.prose` typography and inline math, and plain text
// keeps the HTML-injection surface limited to sanitized KaTeX only.
export function RichText({ content, className }: RichTextProps) {
  const paragraphs = useMemo(() => content.split(/\n{2,}/), [content]);
  return (
    <div className={className}>
      {paragraphs.map((para, pi) => {
        const segments = tokenize(para);
        return (
          <p key={pi}>
            {segments.map((seg, si) =>
              seg.kind === "math" ? (
                <MathSpan key={si} latex={seg.value} display={seg.display} />
              ) : (
                <span key={si}>{seg.value}</span>
              ),
            )}
          </p>
        );
      })}
    </div>
  );
}
