import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { compileExpr, SRC_MAX, TOKEN_MAX } from "./plotExpr";

// Evaluate a compiled expression at x, asserting it compiled.
function evalAt(src: string, x: number): number {
  const fn = compileExpr(src);
  expect(fn, `expected "${src}" to compile`).not.toBeNull();
  return (fn as (x: number) => number)(x);
}

describe("compileExpr — precedence & associativity", () => {
  it("^ binds tighter than a leading unary minus: -x^2 = -(x^2)", () => {
    expect(evalAt("-x^2", 3)).toBe(-9);
    expect(evalAt("-x^2", -3)).toBe(-9);
  });

  it("-3^2 = -9 (unary minus applies to the power)", () => {
    expect(evalAt("-3^2", 0)).toBe(-9);
  });

  it("(-3)^2 = 9 (parenthesized negative base)", () => {
    expect(evalAt("(-3)^2", 0)).toBe(9);
  });

  it("^ is right-associative: 2^3^2 = 512", () => {
    expect(evalAt("2^3^2", 0)).toBe(512);
  });

  it("* and / bind tighter than + and -", () => {
    expect(evalAt("2+3*4", 0)).toBe(14);
    expect(evalAt("10-6/2", 0)).toBe(7);
  });

  it("negative exponents work (2^-2 = 0.25)", () => {
    expect(evalAt("2^-2", 0)).toBe(0.25);
  });
});

describe("compileExpr — functions, constants, numbers", () => {
  it("evaluates the variable and basic arithmetic", () => {
    expect(evalAt("x+1", 4)).toBe(5);
  });

  it("supports the function allowlist", () => {
    expect(evalAt("sin(x)", 0)).toBe(0);
    expect(evalAt("cos(x)", 0)).toBe(1);
    expect(evalAt("sqrt(x)", 9)).toBe(3);
    expect(evalAt("abs(x)", -5)).toBe(5);
    expect(evalAt("exp(x)", 0)).toBe(1);
    expect(evalAt("floor(x)", 2.7)).toBe(2);
    expect(evalAt("ceil(x)", 2.1)).toBe(3);
    expect(evalAt("round(x)", 2.5)).toBe(3);
  });

  it("ln is natural, log10 is base-10, log2 is base-2, bare log = log10", () => {
    expect(evalAt("ln(e)", 0)).toBeCloseTo(1, 12);
    expect(evalAt("log10(x)", 1000)).toBeCloseTo(3, 12);
    expect(evalAt("log2(x)", 8)).toBeCloseTo(3, 12);
    expect(evalAt("log(x)", 100)).toBeCloseTo(2, 12);
  });

  it("knows constants pi and e", () => {
    expect(evalAt("pi", 0)).toBeCloseTo(Math.PI, 12);
    expect(evalAt("e", 0)).toBeCloseTo(Math.E, 12);
    expect(evalAt("sin(pi)", 0)).toBeCloseTo(0, 12);
  });

  it("parses decimals and scientific notation", () => {
    expect(evalAt("1.5", 0)).toBe(1.5);
    expect(evalAt("1.5e-3", 0)).toBeCloseTo(0.0015, 12);
    expect(evalAt("2e3", 0)).toBe(2000);
    expect(evalAt(".5+x", 0)).toBe(0.5);
  });
});

describe("compileExpr — implicit multiplication (only the two allowed forms)", () => {
  it("number-then-x/func/paren is a product", () => {
    expect(evalAt("2x", 3)).toBe(6);
    expect(evalAt("2sin(x)", 0)).toBe(0);
    expect(evalAt("2(x+1)", 3)).toBe(8);
  });

  it("rparen-then-paren is a product: (x+1)(x-1) = x^2-1", () => {
    expect(evalAt("(x+1)(x-1)", 3)).toBe(8);
  });

  it("adjacent letters are ONE identifier -> unknown -> null (never split)", () => {
    expect(compileExpr("xy")).toBeNull();
    expect(compileExpr("pix")).toBeNull();
    expect(compileExpr("x y")).toBeNull(); // no juxtaposition of two idents
  });
});

describe("compileExpr — totality (domain errors -> non-finite, never throw)", () => {
  it("division by zero -> non-finite, does not throw", () => {
    const fn = compileExpr("1/x");
    expect(fn).not.toBeNull();
    const f = fn as (x: number) => number;
    expect(() => f(0)).not.toThrow();
    expect(Number.isFinite(f(0))).toBe(false);
    expect(f(2)).toBe(0.5);
  });

  it("sqrt of a negative -> NaN, ln of <=0 -> non-finite, tan pole -> large finite/inf", () => {
    expect(Number.isNaN(evalAt("sqrt(x)", -4))).toBe(true);
    expect(Number.isNaN(evalAt("ln(x)", -1))).toBe(true);
    expect(evalAt("ln(x)", 0)).toBe(Number.NEGATIVE_INFINITY);
    // tan(pi/2) is a huge value in floating point, but must not throw.
    expect(() => evalAt("tan(x)", Math.PI / 2)).not.toThrow();
  });
});

describe("compileExpr — parse failures return null (never throw)", () => {
  it("unknown function -> null", () => {
    expect(compileExpr("foo(x)")).toBeNull();
    expect(compileExpr("sec(x)")).toBeNull();
  });

  it("syntax errors -> null", () => {
    expect(compileExpr("")).toBeNull();
    expect(compileExpr("x+")).toBeNull();
    expect(compileExpr("(x+1")).toBeNull();
    expect(compileExpr("*x")).toBeNull();
    expect(compileExpr("2 3")).toBeNull(); // two adjacent numbers
    expect(compileExpr("$#@")).toBeNull();
  });

  it("a bare function name without parens -> null", () => {
    expect(compileExpr("sin")).toBeNull();
  });
});

describe("compileExpr — safety bounds", () => {
  it("rejects src longer than SRC_MAX fast", () => {
    const t0 = Date.now();
    expect(compileExpr("x".repeat(10000))).toBeNull();
    expect(compileExpr("1+".repeat(SRC_MAX))).toBeNull(); // over length cap
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("'x'.repeat(10000) returns null fast (no hang)", () => {
    const t0 = Date.now();
    expect(compileExpr("x".repeat(10000))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("10000 nested '(' returns null fast with no stack overflow", () => {
    const t0 = Date.now();
    // Well over both the length cap and the depth cap; must be rejected fast.
    expect(() => compileExpr("(".repeat(10000))).not.toThrow();
    expect(compileExpr("(".repeat(10000))).toBeNull();
    // Even within the length cap, deep nesting past DEPTH_MAX -> null, no throw.
    const deep = "(".repeat(60) + "x" + ")".repeat(60);
    expect(deep.length).toBeLessThan(SRC_MAX);
    expect(() => compileExpr(deep)).not.toThrow();
    expect(compileExpr(deep)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("token cap constant is exposed and enforced", () => {
    expect(TOKEN_MAX).toBe(512);
  });

  it("DEPTH_MAX bounds a unary-sign chain past 32 (not just SRC_MAX)", () => {
    // A leading-sign chain recurses through parseUnary; with parseUnary now
    // wrapped in enter()/leave(), a chain past DEPTH_MAX=32 is rejected as null
    // (was accepted before, bounded only accidentally by SRC_MAX).
    const chain = "-".repeat(100) + "x";
    expect(chain.length).toBeLessThan(SRC_MAX);
    expect(() => compileExpr(chain)).not.toThrow();
    expect(compileExpr(chain)).toBeNull();
    // A short sign chain still compiles (guard bounds depth, doesn't ban unary).
    expect(evalAt("---x", 2)).toBe(-2);
  });

  it("DEPTH_MAX bounds a right-assoc '^' chain past 32 (not just SRC_MAX)", () => {
    // Pure right-associative power chain 2^2^...^2 recurses through parsePower;
    // with parsePower wrapped in enter()/leave() a 100-deep chain is null.
    const chain = Array(100).fill("2").join("^");
    expect(chain.length).toBeLessThan(SRC_MAX);
    expect(() => compileExpr(chain)).not.toThrow();
    expect(compileExpr(chain)).toBeNull();
    // A short power chain still compiles and stays right-associative.
    expect(evalAt("2^3^2", 0)).toBe(512);
  });
});

describe("compileExpr — prototype-pollution names resolve to null", () => {
  it("'__proto__(x)', 'constructor(x)', 'hasOwnProperty(x)' -> null", () => {
    expect(compileExpr("__proto__(x)")).toBeNull();
    expect(compileExpr("constructor(x)")).toBeNull();
    expect(compileExpr("hasOwnProperty(x)")).toBeNull();
    expect(compileExpr("toString(x)")).toBeNull();
    expect(compileExpr("valueOf(x)")).toBeNull();
  });

  it("those names as bare constants also -> null (not read off the prototype)", () => {
    expect(compileExpr("__proto__")).toBeNull();
    expect(compileExpr("constructor")).toBeNull();
  });
});

// The load-bearing CSP invariant: this evaluator must contain NO dynamic code
// execution. A grep gate over the module source fails the moment someone
// reaches for eval / new Function.
describe("no-eval grep gate", () => {
  it("plotExpr.ts source contains no eval and no Function( constructor", () => {
    // Resolve the module source relative to the repo root (this test lives at
    // <root>/src/lib/plotExpr.test.ts, so the module is beside it).
    const modulePath = path.resolve(process.cwd(), "src/lib/plotExpr.ts");
    const src = readFileSync(modulePath, "utf8");
    // Strip line comments and block comments so prose mentioning the words in
    // the module's own documentation cannot mask a real regression.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(code).not.toMatch(/\beval\b/);
    expect(code).not.toMatch(/\bFunction\s*\(/);
    expect(code).not.toMatch(/new\s+Function/);
  });
});
