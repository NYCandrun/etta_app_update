import { tokenize } from "../lib/math";

// Hand-rolled minimal markdown parser for the RichText surface (locked
// decision 3). Block level: ##/### headings, "- " and "1." lists, ``` fenced
// code, GFM pipe tables, "---" thematic breaks, and paragraphs split on blank
// lines. Inline: **bold**, *italic*, `code` — all emitted as a React-friendly
// node tree, NEVER as HTML strings (the only injected HTML in the app remains
// DOMPurify-sanitized KaTeX output).
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

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { type: "heading"; level: 2 | 3; children: InlineNode[] }
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "list"; ordered: boolean; items: InlineNode[][] }
  | { type: "codeBlock"; lang: string; code: string }
  | { type: "table"; header: InlineNode[][]; aligns: Align[]; rows: InlineNode[][][] }
  | { type: "thematicBreak" };

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
  let listOrdered = false;
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
    blocks.push({ type: "list", ordered: listOrdered, items: listItems.map((t) => parseInline(t)) });
    listItems = [];
    listOrdered = false;
  };
  const pushListItem = (text: string, ordered: boolean) => {
    flushPara();
    // A type switch (bulleted <-> numbered) starts a new list block.
    if (listItems.length > 0 && listOrdered !== ordered) flushList();
    listOrdered = ordered;
    listItems.push(text);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (inFence) {
      if (/^\s*```\s*$/.test(line)) {
        blocks.push({ type: "codeBlock", lang: fenceLang, code: fenceLines.join("\n") });
        inFence = false;
        fenceLines = [];
      } else {
        fenceLines.push(line);
      }
      i += 1;
      continue;
    }

    const fenceOpen = /^\s*```(.*)$/.exec(line);
    if (fenceOpen) {
      flushPara();
      flushList();
      inFence = true;
      fenceLang = (fenceOpen[1] ?? "").trim();
      fenceLines = [];
      i += 1;
      continue;
    }

    // GFM pipe table: a row containing "|" immediately followed by a delimiter
    // row (|---|:--:|). Requires the delimiter to have already arrived, so mid
    // stream the bare header renders as a paragraph until its delimiter lands
    // (the same re-block-on-arrival behavior as fenced code).
    if (
      line.includes("|") &&
      !isTableDelimiter(line) &&
      i + 1 < lines.length &&
      isTableDelimiter(lines[i + 1] ?? "")
    ) {
      flushPara();
      flushList();
      const header = splitCells(line).map((c) => parseInline(c));
      const aligns = parseAligns(lines[i + 1] ?? "");
      i += 2;
      const rows: InlineNode[][][] = [];
      while (i < lines.length) {
        const r = lines[i] ?? "";
        if (/^\s*$/.test(r) || !r.includes("|") || /^\s*```/.test(r)) break;
        rows.push(splitCells(r).map((c) => parseInline(c)));
        i += 1;
      }
      blocks.push({ type: "table", header, aligns, rows });
      continue;
    }

    if (/^\s*$/.test(line)) {
      // Blank line: block boundary (this is also the streaming re-block point).
      flushPara();
      flushList();
      i += 1;
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
      i += 1;
      continue;
    }

    // Thematic break: a line of only ---, ***, or ___ (>=3). Checked before the
    // "- " list rule, which needs a space after the dash, so "---" never matches
    // it.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      flushList();
      blocks.push({ type: "thematicBreak" });
      i += 1;
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      pushListItem(ordered[1] ?? "", true);
      i += 1;
      continue;
    }

    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      pushListItem(item[1] ?? "", false);
      i += 1;
      continue;
    }

    flushList();
    para.push(line);
    i += 1;
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
// GFM pipe-table helpers.

// A delimiter row is |---|:--:|---:| : every cell is optional colons around a
// run of dashes, with at least one dash overall. Pipes are required so a plain
// "---" thematic break never reads as a one-column table delimiter.
function isTableDelimiter(line: string): boolean {
  const s = line.trim();
  if (!s.includes("|") || !s.includes("-")) return false;
  const cells = s.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

function parseAligns(line: string): Align[] {
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return s.split("|").map((c) => {
    const t = c.trim();
    const left = t.startsWith(":");
    const right = t.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

// Split a table row into trimmed cell strings. Pipes inside a $...$ math span
// (e.g. absolute value |x|) and backslash-escaped \| are NOT separators.
function splitCells(row: string): string[] {
  const s = row.trim();
  const cells: string[] = [];
  let cur = "";
  let inMath = false;
  for (let k = 0; k < s.length; k += 1) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") {
      cur += "|";
      k += 1;
      continue;
    }
    if (ch === "$") {
      inMath = !inMath;
      cur += ch;
      continue;
    }
    if (ch === "|" && !inMath) {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  // Drop the empty edge cells produced by optional leading/trailing pipes,
  // without swallowing a genuinely empty interior cell.
  if (s.startsWith("|") && cells[0]?.trim() === "") cells.shift();
  if (s.endsWith("|") && cells.at(-1)?.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
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
