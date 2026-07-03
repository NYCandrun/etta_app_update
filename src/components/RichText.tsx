import { useMemo } from "react";
import type { ReactNode } from "react";
import "katex/dist/katex.min.css";
import { MATH_ERROR, renderMath } from "../lib/math";
import { parseMarkdown } from "./markdown";
import type { Block, InlineNode } from "./markdown";

// ONE shared math/markdown renderer for lessons, quiz prompts, explanations,
// and feedback (blocklist: a single RichText surface, never per-screen
// variants). Parsing lives in `./markdown` (blocks + inline markers) composed
// with the `$...$` tokenizer in `../lib/math`; this file only turns the node
// tree into React elements.
//
// Markdown: minimal hand-rolled subset — ##/### headings, "- " lists, fenced
// code, paragraphs on blank lines, **bold**, *italic*, `code` — emitted as
// REAL React elements so `.prose` typography applies. Unclosed markers
// mid-stream degrade to literal text and never throw.
//
// Math: every `$...$` (inline) and `$$...$$` (block) span is rendered by KaTeX
// with MathML so screen readers get real MathML — we NEVER expose raw LaTeX as
// text or as an aria-label. KaTeX HTML is sanitized with DOMPurify before
// `dangerouslySetInnerHTML`; that sanitized KaTeX output remains the ONLY
// injected HTML — all markdown is plain React nodes, so untrusted model output
// cannot inject markup.

export interface RichTextProps {
  content: string;
  className?: string;
}

// Inline/block math node. On a KaTeX failure we show "Math display error" as
// real text (never the raw LaTeX, never as an aria-label). Always a <span>:
// KaTeX display output carries .katex-display (display:block via its CSS), so
// block math lays out correctly without invalid <div>-inside-<p> nesting.
function MathSpan({ latex, display }: { latex: string; display: boolean }) {
  const html = useMemo(() => renderMath(latex, display), [latex, display]);
  if (html === null) {
    return (
      <span role="img" aria-label={MATH_ERROR} className="text-danger">
        {MATH_ERROR}
      </span>
    );
  }
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <span key={i}>{node.value}</span>;
      case "math":
        return <MathSpan key={i} latex={node.latex} display={node.display} />;
      case "strong":
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(node.children)}</em>;
      case "code":
        return <code key={i}>{renderInline(node.children)}</code>;
    }
  });
}

function BlockNode({ block }: { block: Block }) {
  switch (block.type) {
    case "heading":
      return block.level === 2 ? (
        <h2>{renderInline(block.children)}</h2>
      ) : (
        <h3>{renderInline(block.children)}</h3>
      );
    case "list":
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "codeBlock":
      // Verbatim text: fenced content bypasses math and inline markdown.
      return (
        <pre data-lang={block.lang || undefined}>
          <code>{block.code}</code>
        </pre>
      );
    case "paragraph":
      return <p>{renderInline(block.children)}</p>;
  }
}

// The shared renderer. The whole accumulated string is re-parsed per render,
// so streamed chunks re-block on blank-line boundaries automatically.
export function RichText({ content, className }: RichTextProps) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  return (
    <div className={className}>
      {blocks.map((block, i) => (
        <BlockNode key={i} block={block} />
      ))}
    </div>
  );
}
