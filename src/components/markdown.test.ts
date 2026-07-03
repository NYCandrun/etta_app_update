import { describe, it, expect } from "vitest";
import { parseMarkdown, parseInline } from "./markdown";
import type { Block, InlineNode } from "./markdown";

// Collapse an inline tree back to its visible text (math as [latex]) so
// assertions stay readable.
function inlineText(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return n.value;
        case "math":
          return `[${n.latex}]`;
        default:
          return inlineText(n.children);
      }
    })
    .join("");
}

function blockText(b: Block | undefined): string {
  if (!b) return "";
  switch (b.type) {
    case "codeBlock":
      return b.code;
    case "list":
      return b.items.map(inlineText).join("|");
    case "thematicBreak":
      return "---";
    case "table":
      return [b.header, ...b.rows]
        .map((row) => row.map(inlineText).join(" ¦ "))
        .join(" / ");
    default:
      return inlineText(b.children);
  }
}

describe("parseMarkdown — blocks", () => {
  it("parses ## and ### headings; # and #### stay paragraphs", () => {
    const blocks = parseMarkdown("## Key Ideas\n\n### Detail\n\n# nope\n\n#### nope");
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "heading",
      "paragraph",
      "paragraph",
    ]);
    expect(blocks[0]).toMatchObject({ level: 2 });
    expect(blocks[1]).toMatchObject({ level: 3 });
    expect(blockText(blocks[2])).toBe("# nope");
  });

  it("splits paragraphs on blank lines and keeps single newlines inside one", () => {
    const blocks = parseMarkdown("line one\nline two\n\nsecond para");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(blockText(blocks[0])).toBe("line one\nline two");
  });

  it("groups consecutive '- ' lines into one list", () => {
    const blocks = parseMarkdown("intro\n- first\n- second\n\nafter");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "list", "paragraph"]);
    expect(blockText(blocks[1])).toBe("first|second");
  });

  it("fenced code is verbatim: no math, no inline markdown", () => {
    const blocks = parseMarkdown("```python\nx = cost # $5 and $6\ny = a**b\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "codeBlock",
      lang: "python",
      code: "x = cost # $5 and $6\ny = a**b",
    });
  });

  it("an unterminated fence mid-stream renders as a code block in progress", () => {
    const blocks = parseMarkdown("before\n\n```js\nconst a = 1;");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "codeBlock"]);
    expect(blockText(blocks[1])).toBe("const a = 1;");
  });
});

describe("parseMarkdown — tables, ordered lists, rules", () => {
  it("groups consecutive '1.' lines into an ordered list", () => {
    const blocks = parseMarkdown("steps:\n1. shift\n2. scale\n3. reflect\n\ndone");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "list", "paragraph"]);
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true });
    expect(blockText(blocks[1])).toBe("shift|scale|reflect");
  });

  it("a type switch (numbered -> bulleted) starts a new list block", () => {
    const blocks = parseMarkdown("1. one\n2. two\n- bullet");
    expect(blocks.map((b) => b.type)).toEqual(["list", "list"]);
    expect(blocks[0]).toMatchObject({ ordered: true });
    expect(blocks[1]).toMatchObject({ ordered: false });
    expect(blockText(blocks[0])).toBe("one|two");
    expect(blockText(blocks[1])).toBe("bullet");
  });

  it("parses a GFM pipe table with a header, delimiter, and body rows", () => {
    const src = [
      "| Parameter | Effect |",
      "|---|---|",
      "| $h$ | Horizontal shift |",
      "| $k$ | Vertical shift |",
    ].join("\n");
    const blocks = parseMarkdown(src);
    expect(blocks).toHaveLength(1);
    const table = blocks[0];
    expect(table?.type).toBe("table");
    if (table?.type !== "table") throw new Error("expected table");
    expect(table.header.map(inlineText)).toEqual(["Parameter", "Effect"]);
    expect(table.rows).toHaveLength(2);
    // Math inside a cell is still tokenized (KaTeX), not literal.
    expect(table.rows[0]?.map(inlineText)).toEqual(["[h]", "Horizontal shift"]);
  });

  it("reads column alignment from the delimiter row", () => {
    const src = ["| L | C | R |", "|:---|:---:|---:|", "| a | b | c |"].join("\n");
    const table = parseMarkdown(src)[0];
    if (table?.type !== "table") throw new Error("expected table");
    expect(table.aligns).toEqual(["left", "center", "right"]);
  });

  it("does not split cells on a pipe inside a $...$ math span", () => {
    const src = ["| Expr | Note |", "|---|---|", "| $|x|$ | absolute value |"].join("\n");
    const table = parseMarkdown(src)[0];
    if (table?.type !== "table") throw new Error("expected table");
    expect(table.rows[0]).toHaveLength(2);
    expect(table.rows[0]?.map(inlineText)).toEqual(["[|x|]", "absolute value"]);
  });

  it("a header row without its delimiter yet stays a paragraph (mid-stream)", () => {
    const blocks = parseMarkdown("| Parameter | Effect |");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph"]);
  });

  it("parses '---', '***', '___' as thematic breaks, not lists or headings", () => {
    const blocks = parseMarkdown("above\n\n---\n\nbetween\n\n***\n\n___");
    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "thematicBreak",
      "paragraph",
      "thematicBreak",
      "thematicBreak",
    ]);
  });
});

describe("parseInline — markers and math composition", () => {
  it("parses **bold**, *italic*, and `code`", () => {
    const nodes = parseInline("a **b** c *d* e `f`");
    expect(nodes.map((n) => n.type)).toEqual([
      "text",
      "strong",
      "text",
      "em",
      "text",
      "code",
    ]);
    expect(inlineText(nodes)).toBe("a b c d e f");
  });

  it("nests emphasis inside bold", () => {
    const nodes = parseInline("**bold *and em* tail**");
    expect(nodes[0]?.type).toBe("strong");
    const inner = (nodes[0] as { children: InlineNode[] }).children;
    expect(inner.some((n) => n.type === "em")).toBe(true);
    expect(inlineText(nodes)).toBe("bold and em tail");
  });

  it("markdown never re-enters a math span", () => {
    // The * and ** inside $...$ belong to LaTeX, not markdown.
    const nodes = parseInline("solve $a*b$ and $c**d$");
    const math = nodes.filter((n) => n.type === "math");
    expect(math).toHaveLength(2);
    expect(math[0]).toMatchObject({ latex: "a*b" });
    expect(math[1]).toMatchObject({ latex: "c**d" });
    expect(nodes.every((n) => n.type === "text" || n.type === "math")).toBe(true);
  });

  it("bold can wrap around math without splitting it", () => {
    const nodes = parseInline("**note: $x^2$ matters**");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.type).toBe("strong");
    const inner = (nodes[0] as { children: InlineNode[] }).children;
    expect(inner.map((n) => n.type)).toEqual(["text", "math", "text"]);
    expect(inner[1]).toMatchObject({ latex: "x^2" });
  });

  it("unclosed markers degrade to literal text", () => {
    expect(inlineText(parseInline("an unclosed **bold marker"))).toBe(
      "an unclosed **bold marker",
    );
    expect(inlineText(parseInline("a stray ` backtick"))).toBe(
      "a stray ` backtick",
    );
    expect(inlineText(parseInline("a lone *star"))).toBe("a lone *star");
  });
});

describe("streaming degradation (partial chunks)", () => {
  const LESSON = [
    "## Solving Linear Equations",
    "",
    "To isolate $x$ in $3x-7=14$, add **7 to both sides** and use `balance`:",
    "",
    "- add $7$ to each side",
    "- divide by *three*",
    "",
    "The order of operations:",
    "",
    "1. add $7$",
    "2. divide by $3$",
    "",
    "| Step | Result |",
    "|---|---:|",
    "| add $7$ | $3x = 21$ |",
    "| divide | $x = 7$ |",
    "",
    "---",
    "",
    "```text",
    "3x = 21",
    "x = 7",
    "```",
    "",
    "You have \\$5 and earn $3 more — that stays plain money, not math.",
  ].join("\n");

  it("never throws for ANY prefix of a realistic lesson", () => {
    for (let cut = 0; cut <= LESSON.length; cut += 1) {
      expect(() => parseMarkdown(LESSON.slice(0, cut))).not.toThrow();
    }
  });

  it("a cut inside a ** marker renders the marker literally", () => {
    // Cut mid-way through the bold span: "add **7 to bo…"
    const offset = LESSON.indexOf("**7 to both") + 6;
    const blocks = parseMarkdown(LESSON.slice(0, offset));
    const text = blocks.map(blockText).join("\n");
    // The unclosed ** appears literally; nothing was dropped or bolded.
    expect(text).toContain("**7 to");
    const last = blocks[blocks.length - 1];
    expect(last?.type).toBe("paragraph");
    expect(
      (last as { children: InlineNode[] }).children.some(
        (n) => n.type === "strong",
      ),
    ).toBe(false);
  });

  it("a cut inside a $ span renders the dollar literally until it closes", () => {
    const offset = LESSON.indexOf("$3x-7=14$") + 4; // "…in $3x-…"
    const blocks = parseMarkdown(LESSON.slice(0, offset));
    const text = blocks.map(blockText).join("\n");
    expect(text).toContain("$3x");
    expect(text).not.toContain("[3x"); // not typeset yet
  });
});
