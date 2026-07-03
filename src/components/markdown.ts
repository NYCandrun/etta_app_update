import { tokenize } from "../lib/math";

// Hand-rolled minimal markdown parser for the RichText surface (locked
// decision 3). Block level: ##/### headings, "- " lists, ``` fenced code, and
// paragraphs split on blank lines. Inline: **bold**, *italic*, `code` — all
// emitted as a React-friendly node tree, NEVER as HTML strings (the only
// injected HTML in the app remains DOMPurify-sanitized KaTeX output).
//
// Composition with math: each non-fence block runs through the EXISTING
// `$...$` tokenizer in ../lib/math FIRST. Math segments become opaque atoms
// (a placeholder char) before the inline markdown pass, so markdown markers
// can wrap AROUND math (`**see $x$**`) but can never re-enter or split a math
// span (`$a*b$` stays one formula). Fenced code is verbatim: neither math nor
// inline markdown applies inside it.
//
// Streaming degradation: lessons arrive in appended chunks, so ANY prefix of
// a valid document must parse without throwing. Unclosed ** / * / ` render as
// literal text; an unterminated fence renders as a code block in progress;
// re-blocking naturally happens on blank-line boundaries because the whole
// accumulated string is re-parsed each render.

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "math"; latex: string; display: boolean }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "code"; children: InlineNode[] };

export type Block =
  | { type: "heading"; level: 2 | 3; children: InlineNode[] }
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "list"; items: InlineNode[][] }
  | { type: "codeBlock"; lang: string; code: string };

// Placeholder for math atoms inside the inline-markdown pass. A Private Use
// Area char never appears in model output; we strip any stray occurrences
// from the source text so the atom queue can never desync.
const ATOM = "\uE000";

type MathAtom = { latex: string; display: boolean };

export function parseMarkdown(content: string): Block[] {
  const blocks: Block[] = [];
  const lines = content.split("\n");

  let para: string[] = [];
  let listItems: string[] = [];
  let inFence = false;
  let fenceLang = "";
  let fenceLines: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const text = para.join("\n");
    para = [];
    if (text.trim().length > 0) {
      blocks.push({ type: "paragraph", children: parseInline(text) });
    }
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push({ type: "list", items: listItems.map((t) => parseInline(t)) });
    listItems = [];
  };

  for (const line of lines) {
    if (inFence) {
      if (/^\s*```\s*$/.test(line)) {
        blocks.push({ type: "codeBlock", lang: fenceLang, code: fenceLines.join("\n") });
        inFence = false;
        fenceLines = [];
      } else {
        fenceLines.push(line);
      }
      continue;
    }

    const fenceOpen = /^\s*```(.*)$/.exec(line);
    if (fenceOpen) {
      flushPara();
      flushList();
      inFence = true;
      fenceLang = (fenceOpen[1] ?? "").trim();
      fenceLines = [];
      continue;
    }

    if (/^\s*$/.test(line)) {
      // Blank line: block boundary (this is also the streaming re-block point).
      flushPara();
      flushList();
      continue;
    }

    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({
        type: "heading",
        level: (heading[1] ?? "").length === 2 ? 2 : 3,
        children: parseInline(heading[2] ?? ""),
      });
      continue;
    }

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      listItems.push(item[1] ?? "");
      continue;
    }

    flushList();
    para.push(line);
  }

  if (inFence) {
    // Unterminated fence mid-stream: show what we have as a code block.
    blocks.push({ type: "codeBlock", lang: fenceLang, code: fenceLines.join("\n") });
  }
  flushPara();
  flushList();
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline pass: math first (existing tokenizer), then markdown over a string in
// which every math segment is a single opaque placeholder char.

export function parseInline(text: string): InlineNode[] {
  const segments = tokenize(text);
  const atoms: MathAtom[] = [];
  let flat = "";
  for (const seg of segments) {
    if (seg.kind === "math") {
      atoms.push({ latex: seg.value, display: seg.display });
      flat += ATOM;
    } else {
      // Strip stray placeholder chars so atom order can never desync.
      flat += seg.value.split(ATOM).join("");
    }
  }
  // Atoms are emitted strictly left-to-right, so a FIFO queue is sufficient.
  const queue = atoms[Symbol.iterator]();
  return parseInlineString(flat, () => queue.next().value as MathAtom);
}

function parseInlineString(s: string, nextAtom: () => MathAtom): InlineNode[] {
  const nodes: InlineNode[] = [];
  let plain = "";

  const flushPlain = () => {
    if (plain.length > 0) {
      nodes.push(...textNodes(plain, nextAtom));
      plain = "";
    }
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];

    if (ch === "`") {
      const close = s.indexOf("`", i + 1);
      if (close > i + 1) {
        flushPlain();
        // Verbatim span: no nested markdown, but math atoms already extracted
        // from the source still render (math always wins over inline code).
        nodes.push({ type: "code", children: textNodes(s.slice(i + 1, close), nextAtom) });
        i = close + 1;
        continue;
      }
      plain += ch; // unterminated (or empty ``): literal backtick
      i += 1;
      continue;
    }

    if (s.startsWith("**", i)) {
      const close = s.indexOf("**", i + 2);
      if (close > i + 2) {
        flushPlain();
        nodes.push({
          type: "strong",
          children: parseInlineString(s.slice(i + 2, close), nextAtom),
        });
        i = close + 2;
        continue;
      }
      plain += "**"; // unterminated or empty: literal
      i += 2;
      continue;
    }

    if (ch === "*") {
      const close = findSingleStar(s, i + 1);
      if (close > i + 1) {
        flushPlain();
        nodes.push({
          type: "em",
          children: parseInlineString(s.slice(i + 1, close), nextAtom),
        });
        i = close + 1;
        continue;
      }
      plain += "*"; // unterminated: literal
      i += 1;
      continue;
    }

    plain += ch;
    i += 1;
  }
  flushPlain();
  return nodes;
}

// Find the next lone "*" (not part of "**") so `*em **nested** end*` closes at
// the final star instead of inside the bold marker. Returns -1 when absent.
function findSingleStar(s: string, from: number): number {
  for (let i = from; i < s.length; i += 1) {
    if (s[i] !== "*") continue;
    if (s[i + 1] === "*" || s[i - 1] === "*") continue;
    return i;
  }
  return -1;
}

// Convert a run of plain chars (possibly containing math placeholders) into
// text/math nodes, consuming atoms in order.
function textNodes(s: string, nextAtom: () => MathAtom): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buf = "";
  for (const ch of s) {
    if (ch === ATOM) {
      if (buf.length > 0) {
        nodes.push({ type: "text", value: buf });
        buf = "";
      }
      const atom = nextAtom();
      nodes.push({ type: "math", latex: atom.latex, display: atom.display });
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) {
    nodes.push({ type: "text", value: buf });
  }
  return nodes;
}
