import { describe, it, expect } from "vitest";
import {
  parseChartSpec,
  DEFAULT_DOMAIN,
  BODY_MAX_BYTES,
  type FunctionSpec,
  type DataSpec,
} from "./chartSpec";

describe("parseChartSpec — function plots", () => {
  it("normalizes a valid funcs spec and compiles each expr", () => {
    const spec = parseChartSpec(
      JSON.stringify({
        title: "Parabola",
        xlabel: "x",
        ylabel: "y",
        domain: [-4, 4],
        funcs: [
          { expr: "x^2", label: "parent" },
          { expr: "(x-2)^2+1", label: "shift" },
        ],
      }),
    ) as FunctionSpec | null;
    expect(spec).not.toBeNull();
    expect(spec?.type).toBe("function");
    expect(spec?.domain).toEqual([-4, 4]);
    expect(spec?.funcs).toHaveLength(2);
    // The compiled fn is callable and correct.
    expect(spec?.funcs[0]?.fn(3)).toBe(9);
    expect(spec?.funcs[1]?.fn(2)).toBe(1);
  });

  it("defaults the domain to DEFAULT_DOMAIN when missing/invalid", () => {
    const spec = parseChartSpec(
      JSON.stringify({ funcs: [{ expr: "x" }] }),
    ) as FunctionSpec | null;
    expect(spec?.domain).toEqual(DEFAULT_DOMAIN);
    const bad = parseChartSpec(
      JSON.stringify({ domain: [5, 5], funcs: [{ expr: "x" }] }),
    ) as FunctionSpec | null;
    expect(bad?.domain).toEqual(DEFAULT_DOMAIN); // lo<hi violated -> default
  });

  it("drops individual funcs that fail to compile but keeps the rest", () => {
    const spec = parseChartSpec(
      JSON.stringify({ funcs: [{ expr: "xy" }, { expr: "x^2" }] }),
    ) as FunctionSpec | null;
    expect(spec).not.toBeNull();
    expect(spec?.funcs).toHaveLength(1);
    expect(spec?.funcs[0]?.fn(2)).toBe(4);
  });

  it("returns null when ALL funcs fail to compile", () => {
    expect(
      parseChartSpec(JSON.stringify({ funcs: [{ expr: "xy" }, { expr: "foo(x)" }] })),
    ).toBeNull();
  });

  it("returns null for an empty funcs array", () => {
    expect(parseChartSpec(JSON.stringify({ funcs: [] }))).toBeNull();
  });
});

describe("parseChartSpec — data charts", () => {
  it("normalizes a valid line/scatter/bar data spec", () => {
    for (const kind of ["line", "scatter", "bar"] as const) {
      const spec = parseChartSpec(
        JSON.stringify({
          kind,
          data: [{ label: "s1", points: [[0, 0], [1, 2], [2, 4]] }],
        }),
      ) as DataSpec | null;
      expect(spec?.type).toBe("data");
      expect(spec?.kind).toBe(kind);
      expect(spec?.data[0]?.points).toEqual([[0, 0], [1, 2], [2, 4]]);
    }
  });

  it("skips non-finite / malformed points, keeps finite ones", () => {
    const spec = parseChartSpec(
      JSON.stringify({
        kind: "scatter",
        data: [
          {
            points: [
              [0, 0],
              [1, null],
              [2, "x"],
              [3, 9],
              ["a", 1],
              [4],
            ],
          },
        ],
      }),
    ) as DataSpec | null;
    // Only [0,0] and [3,9] survive.
    expect(spec?.data[0]?.points).toEqual([[0, 0], [3, 9]]);
  });

  it("returns null for a bad/missing kind", () => {
    expect(
      parseChartSpec(JSON.stringify({ kind: "pie", data: [{ points: [[0, 0]] }] })),
    ).toBeNull();
    expect(
      parseChartSpec(JSON.stringify({ data: [{ points: [[0, 0]] }] })),
    ).toBeNull();
  });

  it("returns null when no series has any finite point", () => {
    expect(
      parseChartSpec(
        JSON.stringify({ kind: "line", data: [{ points: [[NaN, 1]] }, { points: [] }] }),
      ),
    ).toBeNull();
    // Note: NaN serializes to null in JSON, so this exercises the non-finite path.
  });

  it("keeps bar categories when present", () => {
    const spec = parseChartSpec(
      JSON.stringify({
        kind: "bar",
        categories: ["A", "B"],
        data: [{ points: [[0, 3], [1, 5]] }],
      }),
    ) as DataSpec | null;
    expect(spec?.categories).toEqual(["A", "B"]);
  });
});

describe("parseChartSpec — totality & hostile input (never throws, no pollution)", () => {
  it("returns null for partial/truncated mid-stream JSON without throwing", () => {
    const full = '{"funcs":[{"expr":"x^2","label":"p"}]}';
    for (let cut = 0; cut < full.length; cut += 1) {
      expect(() => parseChartSpec(full.slice(0, cut))).not.toThrow();
      // Every strict prefix is invalid JSON (or an incomplete object) -> null.
      expect(parseChartSpec(full.slice(0, cut))).toBeNull();
    }
    // The complete body parses.
    expect(parseChartSpec(full)).not.toBeNull();
  });

  it("returns null on a body over the byte cap without parsing it", () => {
    const huge = '{"funcs":[{"expr":"x"}],"pad":"' + "a".repeat(BODY_MAX_BYTES) + '"}';
    expect(huge.length).toBeGreaterThan(BODY_MAX_BYTES);
    expect(parseChartSpec(huge)).toBeNull();
  });

  it("measures the byte cap in real UTF-8 bytes, not UTF-16 code units", () => {
    // A body of multibyte BMP characters whose UTF-16 length is UNDER the cap
    // but whose UTF-8 byte length is OVER it must be rejected — otherwise the
    // constant named "*_BYTES" would admit ~3x its stated byte budget.
    const cjk = "一".repeat(BODY_MAX_BYTES - 200); // 3 UTF-8 bytes each
    const body = '{"funcs":[{"expr":"x"}],"pad":"' + cjk + '"}';
    // Under the UTF-16 code-unit gate the OLD check used...
    expect(body.length).toBeLessThan(BODY_MAX_BYTES);
    // ...but well over the cap in real UTF-8 bytes.
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(BODY_MAX_BYTES);
    expect(parseChartSpec(body)).toBeNull();
  });

  it("returns null for neither/both discriminators missing and non-objects", () => {
    expect(parseChartSpec("{}")).toBeNull();
    expect(parseChartSpec("[]")).toBeNull();
    expect(parseChartSpec("42")).toBeNull();
    expect(parseChartSpec('"hi"')).toBeNull();
    expect(parseChartSpec("null")).toBeNull();
  });

  it("a '__proto__' / 'constructor' key in the body does not pollute", () => {
    const before = ({} as Record<string, unknown>).polluted;
    // JSON with a __proto__ key alongside a valid funcs array.
    const spec = parseChartSpec(
      '{"funcs":[{"expr":"x"}],"__proto__":{"polluted":"yes"},"constructor":{"bad":1}}',
    );
    expect(spec).not.toBeNull();
    // No prototype was mutated.
    expect(({} as Record<string, unknown>).polluted).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // The normalized spec did not carry the hostile keys.
    expect(Object.hasOwn(spec as object, "polluted")).toBe(false);
  });
});
