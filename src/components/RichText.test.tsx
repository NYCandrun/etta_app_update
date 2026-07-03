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
