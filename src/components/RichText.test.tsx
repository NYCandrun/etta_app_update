import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RichText } from "./RichText";

const LESSON = [
  "## Key Ideas",
  "",
  "Isolate $x$ by adding **7 to both sides**, then use `balance`.",
  "",
  "- add *seven*",
  "- divide by three",
  "",
  "```text",
  "3x = 21",
  "```",
].join("\n");

describe("RichText markdown rendering", () => {
  it("emits real h2/ul/li/strong/em/code elements (not literal markers)", () => {
    const { container } = render(<RichText content={LESSON} className="prose" />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Key Ideas" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(container.querySelector("strong")).toHaveTextContent(
      "7 to both sides",
    );
    expect(container.querySelector("em")).toHaveTextContent("seven");
    expect(container.querySelector("pre code")).toHaveTextContent("3x = 21");
    // No literal markdown markers survive in the rendered text.
    expect(container.textContent).not.toContain("##");
    expect(container.textContent).not.toContain("**");
    expect(container.textContent).not.toContain("```");
  });

  it("renders a GFM pipe table as a real table (not literal pipes)", () => {
    const src = [
      "| Parameter | Effect |",
      "|---|---:|",
      "| $h$ | Horizontal shift |",
      "| $k$ | Vertical shift |",
    ].join("\n");
    const { container } = render(<RichText content={src} className="prose" />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("thead th")).toHaveLength(2);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    // Right-aligned second column carries the alignment from the delimiter.
    expect(container.querySelectorAll("thead th")[1]).toHaveStyle({
      textAlign: "right",
    });
    // No raw pipe/delimiter syntax leaks into the rendered text.
    expect(container.textContent).not.toContain("|---");
    expect(container.textContent).not.toContain("| Parameter |");
    // Math in a cell still typesets.
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("renders '1.' as an ordered list and '---' as a horizontal rule", () => {
    const src = "1. first\n2. second\n\n---\n\nafter";
    const { container } = render(<RichText content={src} className="prose" />);
    expect(container.querySelector("ol")).not.toBeNull();
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelector("hr")).not.toBeNull();
    expect(container.textContent).not.toContain("1. first");
    expect(container.textContent).not.toContain("---");
  });

  it("still renders $...$ through KaTeX (sanitized), never as literal LaTeX", () => {
    const { container } = render(<RichText content="Solve $3x-7=14$ now." />);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).not.toContain("$3x-7=14$");
  });

  it("keeps currency dollars literal", () => {
    const { container } = render(
      <RichText content="You have $5 and earn $3 today." />,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("You have $5 and earn $3 today.");
  });

  it("markdown inside a math span is left to KaTeX", () => {
    const { container } = render(<RichText content="Compute $a*b*c$." />);
    // The stars belong to LaTeX: no <em> may be created inside the formula.
    expect(container.querySelector("em")).toBeNull();
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("degrades a mid-marker streaming cut to literal text without throwing", () => {
    // Cut the lesson mid-way through the "**7 to both sides**" bold marker,
    // as a streamed chunk boundary would.
    const offset = LESSON.indexOf("**7 to") + 4;
    const partial = LESSON.slice(0, offset);
    expect(() => render(<RichText content={partial} />)).not.toThrow();
    const { container } = render(<RichText content={partial} />);
    // The unclosed ** renders literally and nothing is bolded yet.
    expect(container.textContent).toContain("**7");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("never throws for any streamed prefix of the lesson", () => {
    for (let cut = 0; cut <= LESSON.length; cut += 7) {
      expect(() =>
        render(<RichText content={LESSON.slice(0, cut)} />),
      ).not.toThrow();
    }
  });
});

// The `etta-chart` fenced block flows through the SAME verbatim codeBlock path
// as any fence, but RichText's codeBlock branch intercepts `lang === "etta-chart"`
// and dispatches to the inline chart renderer when the JSON body validates.
describe("RichText — etta-chart blocks", () => {
  const CHART = [
    "Here is the graph:",
    "",
    "```etta-chart",
    '{"domain":[-4,4],"funcs":[{"expr":"x^2","label":"parent"}]}',
    "```",
    "",
    "Done.",
  ].join("\n");

  it("renders a complete etta-chart block as an <svg>, not literal JSON", () => {
    const { container } = render(<RichText content={CHART} className="prose" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("role")).toBe("img");
    expect(container.querySelector(".etta-chart-wrap")).not.toBeNull();
    // The raw JSON must NOT appear as a code block.
    expect(container.textContent).not.toContain('{"domain"');
    expect(container.querySelector("pre")).toBeNull();
  });

  it("renders a truncated etta-chart prefix as <pre> and never throws (all prefixes)", () => {
    // Every streamed prefix of the chart lesson must parse without throwing;
    // while the JSON body is incomplete it degrades to a readable code block.
    for (let cut = 0; cut <= CHART.length; cut += 1) {
      expect(() =>
        render(<RichText content={CHART.slice(0, cut)} />),
      ).not.toThrow();
    }
    // A specific mid-JSON cut shows the partial body verbatim in a <pre>, not
    // an <svg>.
    const openIdx = CHART.indexOf("```etta-chart");
    const partial = CHART.slice(0, CHART.indexOf('"label"'));
    const { container } = render(<RichText content={partial} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.textContent).toContain('{"domain"');
    expect(openIdx).toBeGreaterThanOrEqual(0);
  });

  it("falls back to a code block when the etta-chart body is complete but invalid", () => {
    const bad = ["```etta-chart", '{"funcs":[{"expr":"xy"}]}', "```"].join("\n");
    const { container } = render(<RichText content={bad} />);
    // All funcs fail to compile -> null spec -> readable code block, no svg.
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("pre code")).toHaveTextContent(
      '{"funcs":[{"expr":"xy"}]}',
    );
  });

  it("leaves a normal ```json fence unaffected (rendered as a code block)", () => {
    const src = ["```json", '{"domain":[-4,4],"funcs":[{"expr":"x^2"}]}', "```"].join(
      "\n",
    );
    const { container } = render(<RichText content={src} />);
    // A non-etta-chart language is never turned into a chart.
    expect(container.querySelector("svg")).toBeNull();
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.getAttribute("data-lang")).toBe("json");
    expect(container.querySelector("pre code")).toHaveTextContent('"expr":"x^2"');
  });
});
