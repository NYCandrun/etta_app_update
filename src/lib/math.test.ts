import { describe, it, expect } from "vitest";
import { renderMath, tokenize, MATH_ERROR } from "./math";

// Bug 0f: the v1 diagnostic rendered "$3x-7=14$" as literal text on screen one.
// The shared renderer must turn that LaTeX into real KaTeX markup, never echo
// the raw source — and must never expose raw LaTeX on a failure path.
describe("renderMath (bug 0f)", () => {
  it("renders LaTeX via KaTeX, not as literal text", () => {
    const html = renderMath("3x-7=14", false);
    expect(html).not.toBeNull();
    // KaTeX output carries its signature class and MathML for screen readers.
    expect(html).toContain("katex");
    expect(html).toContain("</math>"); // htmlAndMathml => real MathML present
    // The raw source string must NOT survive as bare text.
    expect(html).not.toContain("$3x-7=14$");
  });

  it("returns null on malformed LaTeX so callers show the error sentinel", () => {
    // An unmatched brace makes KaTeX throw; we must NOT fall back to raw LaTeX.
    expect(renderMath("\\frac{1}{", false)).toBeNull();
    // The sentinel the component shows is plain text, never the LaTeX source.
    expect(MATH_ERROR).toBe("Math display error");
  });
});

describe("tokenize", () => {
  it("separates inline math from surrounding prose", () => {
    const segs = tokenize("Solve $3x-7=14$ for x.");
    expect(segs.map((s) => s.kind)).toEqual(["text", "math", "text"]);
    expect(segs[1]).toMatchObject({ value: "3x-7=14", display: false });
  });

  it("recognizes block math and escaped dollars", () => {
    expect(tokenize("$$E=mc^2$$")[0]).toMatchObject({
      kind: "math",
      display: true,
    });
    // An escaped \$ is literal text, not a delimiter.
    expect(tokenize("cost is \\$5").every((s) => s.kind === "text")).toBe(true);
  });

  // Currency guard: bare dollar amounts in word problems must never be
  // typeset as math ("5 and earn " in italics with digits leaking out).
  describe("currency dollar signs", () => {
    it("keeps 'You have $5 and earn $3' entirely literal", () => {
      const segs = tokenize("You have $5 and earn $3");
      expect(segs.every((s) => s.kind === "text")).toBe(true);
      expect(segs.map((s) => s.value).join("")).toBe(
        "You have $5 and earn $3",
      );
    });

    it("keeps a price range like $5-$10 literal (closing $ followed by digit)", () => {
      const segs = tokenize("Prices run $5-$10 today.");
      expect(segs.every((s) => s.kind === "text")).toBe(true);
      expect(segs.map((s) => s.value).join("")).toBe("Prices run $5-$10 today.");
    });

    it("still typesets a valid span after a literal currency $", () => {
      const segs = tokenize("You have $5, so solve $x+5=9$ now");
      const math = segs.filter((s) => s.kind === "math");
      expect(math).toHaveLength(1);
      expect(math[0]?.value).toBe("x+5=9");
      expect(segs[0]?.value).toContain("$5");
    });

    it("rejects an opening $ followed by a space", () => {
      const segs = tokenize("win $ 100 today");
      expect(segs.every((s) => s.kind === "text")).toBe(true);
    });

    it("requires the closing $ on the same line for inline math", () => {
      const segs = tokenize("cost $5\nand x$ stays text");
      expect(segs.every((s) => s.kind === "text")).toBe(true);
      // Block math may still span lines.
      expect(tokenize("$$a\n+b$$")[0]).toMatchObject({
        kind: "math",
        display: true,
      });
    });

    it("a lone trailing $ mid-stream stays literal and never throws", () => {
      const segs = tokenize("Solve $3x-");
      expect(segs.every((s) => s.kind === "text")).toBe(true);
      expect(segs.map((s) => s.value).join("")).toBe("Solve $3x-");
    });
  });
});
