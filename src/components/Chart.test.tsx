import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Chart, ChartErrorBoundary } from "./Chart";
import { parseChartSpec } from "../lib/chartSpec";
import type { ChartSpec } from "../lib/chartSpec";

// Build a validated spec the way RichText does (through the real validator), so
// these tests exercise the same path the app uses.
function spec(json: object): ChartSpec {
  const s = parseChartSpec(JSON.stringify(json));
  if (s === null) throw new Error("test spec failed to validate");
  return s;
}

describe("Chart — function plot", () => {
  it("renders an <svg role=img> with at least one <path>", () => {
    const { container } = render(
      <Chart spec={spec({ domain: [-4, 4], funcs: [{ expr: "x^2", label: "parent" }] })} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("role")).toBe("img");
    expect(container.querySelectorAll("path").length).toBeGreaterThanOrEqual(1);
  });

  it("labels the svg with a <title>/<desc> whose text is DERIVED, not the raw expr", () => {
    const { container } = render(
      <Chart
        spec={spec({
          domain: [-4, 4],
          xlabel: "x",
          ylabel: "y",
          funcs: [
            { expr: "x^2", label: "parent" },
            { expr: "(x-2)^2+1", label: "shift" },
          ],
        })}
      />,
    );
    const title = container.querySelector("title");
    const desc = container.querySelector("desc");
    expect(title).not.toBeNull();
    expect(desc).not.toBeNull();
    const descText = desc?.textContent ?? "";
    // Derived summary mentions the count / labels / domain...
    expect(descText).toContain("2 functions");
    expect(descText).toContain("parent");
    expect(descText).toContain("shift");
    expect(descText).toContain("[-4, 4]");
    // ...but NEVER the raw expression source.
    expect(descText).not.toContain("x^2");
    expect(descText).not.toContain("(x-2)^2+1");
    // aria-labelledby wires both ids.
    const svg = container.querySelector("svg");
    const labelledby = svg?.getAttribute("aria-labelledby") ?? "";
    expect(labelledby.split(" ")).toHaveLength(2);
    expect(labelledby).toContain(title?.getAttribute("id") ?? "@@");
    expect(labelledby).toContain(desc?.getAttribute("id") ?? "@@");
  });

  it("renders one legend entry per series", () => {
    const { container } = render(
      <Chart
        spec={spec({
          funcs: [{ expr: "x", label: "a" }, { expr: "x^2", label: "b" }],
        })}
      />,
    );
    const legendTexts = Array.from(container.querySelectorAll("text"))
      .map((t) => t.textContent)
      .filter((t) => t === "a" || t === "b");
    expect(legendTexts).toContain("a");
    expect(legendTexts).toContain("b");
  });

  it("breaks 1/x into multiple subpaths (no false vertical asymptote)", () => {
    const { container } = render(
      <Chart spec={spec({ domain: [-5, 5], funcs: [{ expr: "1/x" }] })} />,
    );
    const path = container.querySelector("path");
    const d = path?.getAttribute("d") ?? "";
    const moveCommands = (d.match(/M/g) ?? []).length;
    // Two branches => at least two "M" move commands, i.e. a gap at x=0.
    expect(moveCommands).toBeGreaterThan(1);
  });
});

describe("Chart — data charts", () => {
  it("scatter renders <circle> marks", () => {
    const { container } = render(
      <Chart
        spec={spec({ kind: "scatter", data: [{ points: [[0, 0], [1, 1], [2, 4]] }] })}
      />,
    );
    expect(container.querySelectorAll("circle").length).toBeGreaterThanOrEqual(3);
  });

  it("bar renders <rect> bars (beyond the axis frame rect)", () => {
    const { container } = render(
      <Chart
        spec={spec({
          kind: "bar",
          categories: ["A", "B", "C"],
          data: [{ points: [[0, 3], [1, 5], [2, 2]] }],
        })}
      />,
    );
    // One frame rect + three bars.
    expect(container.querySelectorAll("rect").length).toBeGreaterThanOrEqual(4);
  });

  it("bar chart suppresses the decimal x-axis and keeps category labels", () => {
    const { container } = render(
      <Chart
        spec={spec({
          kind: "bar",
          categories: ["A", "B", "C"],
          data: [{ points: [[0, 3], [1, 5], [2, 2]] }],
        })}
      />,
    );
    const texts = Array.from(container.querySelectorAll("text")).map(
      (t) => t.textContent,
    );
    // No bogus decimal x-tick labels from the [0,1] placeholder domain...
    for (const bogus of ["0.2", "0.4", "0.6", "0.8"]) {
      expect(texts).not.toContain(bogus);
    }
    // ...but the category labels under each group remain.
    expect(texts).toContain("A");
    expect(texts).toContain("B");
    expect(texts).toContain("C");
  });

  it("data-chart desc summarizes kind and series count", () => {
    const { container } = render(
      <Chart
        spec={spec({
          kind: "scatter",
          xlabel: "Temperature (K)",
          ylabel: "Luminosity",
          data: [{ label: "main sequence", points: [[0, 0], [1, 1]] }],
        })}
      />,
    );
    const descText = container.querySelector("desc")?.textContent ?? "";
    expect(descText).toContain("Scatter chart");
    expect(descText).toContain("main sequence");
    expect(descText).toContain("Temperature (K)");
  });
});

describe("Chart — axis tick labels (step-aware fmt)", () => {
  it("labels sub-0.01 ticks at their true value (no 2x-rounding, no duplicates)", () => {
    // A small-amplitude scatter: y in ~[0.002, 0.03] yields a 0.005 tick step.
    // Old fmt (hardcoded toFixed(2)) rendered these as 0/0.01/0.01/... (wrong,
    // duplicated); the step-aware fmt must render the exact distinct values.
    const { container } = render(
      <Chart
        spec={spec({
          kind: "line",
          data: [{ points: [[0, 0.002], [1, 0.015], [2, 0.03]] }],
        })}
      />,
    );
    const texts = Array.from(container.querySelectorAll("text")).map(
      (t) => t.textContent,
    );
    // The tick that used to mis-render as "0.01" must show its true value.
    expect(texts).toContain("0.005");
    expect(texts).toContain("0.015");
    expect(texts).toContain("0.025");
  });

  it("never emits the literal '-0' for small negative ticks", () => {
    // A fine-step range straddling zero used to render '-0' for -0.001/-0.002.
    const { container } = render(
      <Chart
        spec={spec({
          kind: "line",
          data: [{ points: [[0, -0.002], [1, 0], [2, 0.002]] }],
        })}
      />,
    );
    const texts = Array.from(container.querySelectorAll("text")).map(
      (t) => t.textContent,
    );
    expect(texts).not.toContain("-0");
    // and the true fine values are present and signed correctly.
    expect(texts).toContain("-0.001");
    expect(texts).toContain("0.001");
  });
});

describe("Chart — series are distinguishable beyond color alone", () => {
  it("color+dash pairs are unique across 20 series (co-prime cycles)", () => {
    // 20 function curves; each <path> stroke (color) + strokeDasharray (dash)
    // pair must be unique, so series 6+ are not pixel-identical to series 1+.
    const funcs = Array.from({ length: 20 }, (_, i) => ({
      expr: `x+${i}`,
      label: `s${i}`,
    }));
    const { container } = render(<Chart spec={spec({ domain: [-2, 2], funcs })} />);
    const curvePaths = Array.from(container.querySelectorAll("path"));
    // The 20 series curves are the paths carrying a stroke color.
    const pairs = curvePaths
      .map((p) => `${p.getAttribute("stroke")}|${p.getAttribute("stroke-dasharray") ?? ""}`)
      .filter((p) => p.startsWith("rgb"));
    expect(pairs).toHaveLength(20);
    expect(new Set(pairs).size).toBe(20); // all distinct
  });

  it("scatter uses per-series SHAPES, not color alone", () => {
    // Two series -> two DIFFERENT mark element types (circle vs square), so a
    // grayscale/color-blind reader can tell them apart.
    const { container } = render(
      <Chart
        spec={spec({
          kind: "scatter",
          data: [
            { label: "A", points: [[0, 0], [1, 1]] },
            { label: "B", points: [[0, 1], [1, 0]] },
          ],
        })}
      />,
    );
    // series 0 -> "circle" -> <circle>; series 1 -> "square" -> <rect>.
    expect(container.querySelectorAll("circle").length).toBeGreaterThanOrEqual(2);
    // The frame rect + series-1 square marks; more than just the frame rect.
    expect(container.querySelectorAll("rect").length).toBeGreaterThanOrEqual(3);
  });

  it("bars carry a per-series hatch pattern (color-independent channel)", () => {
    const { container } = render(
      <Chart
        spec={spec({
          kind: "bar",
          categories: ["A", "B"],
          data: [
            { label: "s1", points: [[0, 3], [1, 5]] },
            { label: "s2", points: [[0, 2], [1, 4]] },
          ],
        })}
      />,
    );
    // Two distinct <pattern> defs, one per series.
    const patterns = Array.from(container.querySelectorAll("pattern"));
    expect(patterns.length).toBe(2);
    const ids = patterns.map((p) => p.getAttribute("id"));
    expect(new Set(ids).size).toBe(2);
    // Bars are filled by the per-series hatch (url(#...)), not a flat color.
    const barFills = Array.from(container.querySelectorAll("rect"))
      .map((r) => r.getAttribute("fill") ?? "")
      .filter((f) => f.startsWith("url(#"));
    expect(barFills.length).toBeGreaterThanOrEqual(4); // 2 series x 2 groups
    expect(new Set(barFills).size).toBe(2); // one distinct hatch per series
  });
});

describe("Chart — error boundary", () => {
  function Boom(): never {
    throw new Error("boom");
  }
  it("catches a thrown child and shows the fallback", () => {
    // Silence the expected React error-boundary console noise.
    const { getByText, queryByText } = render(
      <ChartErrorBoundary fallback={<pre>fallback content</pre>}>
        <Boom />
      </ChartErrorBoundary>,
    );
    expect(getByText("fallback content")).toBeInTheDocument();
    expect(queryByText("boom")).toBeNull();
  });

  it("renders children normally when they do not throw", () => {
    const { getByText } = render(
      <ChartErrorBoundary fallback={<pre>fallback</pre>}>
        <span>ok</span>
      </ChartErrorBoundary>,
    );
    expect(getByText("ok")).toBeInTheDocument();
  });

  it("clears the failed latch when resetKey changes (re-stream recovery)", () => {
    // A boundary that caught a throw must NOT stay stuck on the fallback once a
    // fresh, non-throwing child arrives with a new resetKey — the streaming
    // case where a truncated body grows into a valid spec.
    const { getByText, queryByText, rerender } = render(
      <ChartErrorBoundary resetKey="v1" fallback={<pre>fallback content</pre>}>
        <Boom />
      </ChartErrorBoundary>,
    );
    expect(getByText("fallback content")).toBeInTheDocument();

    // Same resetKey -> latch persists even with a good child (React never
    // auto-resets error state).
    rerender(
      <ChartErrorBoundary resetKey="v1" fallback={<pre>fallback content</pre>}>
        <span>recovered</span>
      </ChartErrorBoundary>,
    );
    expect(queryByText("recovered")).toBeNull();
    expect(getByText("fallback content")).toBeInTheDocument();

    // New resetKey -> latch clears and the good child renders.
    rerender(
      <ChartErrorBoundary resetKey="v2" fallback={<pre>fallback content</pre>}>
        <span>recovered</span>
      </ChartErrorBoundary>,
    );
    expect(getByText("recovered")).toBeInTheDocument();
    expect(queryByText("fallback content")).toBeNull();
  });
});
