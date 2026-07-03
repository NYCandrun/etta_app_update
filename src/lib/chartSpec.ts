// Total parse + validation for an `etta-chart` fenced-block body. Turns the raw
// JSON string the model emitted into a normalized, renderable spec — or null.
//
// This runs on EVERY RichText render, thousands of times mid-stream against
// truncated JSON prefixes, so it must be fast and TOTAL: it never throws.
// JSON.parse lives in a try/catch (partial JSON -> null); a byte cap guards
// huge input before parse; the normalized object is built field-by-field so a
// hostile '__proto__'/'constructor' key in the body can never pollute a
// prototype (we never spread or Object.assign untrusted data).

import { compileExpr } from "./plotExpr";

// Raw fence-body byte cap before JSON.parse (guards a pathological huge block).
export const BODY_MAX_BYTES = 8 * 1024;

// Cached at module scope so we don't allocate an encoder on every stream tick.
// Used to measure the body in real UTF-8 bytes (not UTF-16 code units) so the
// cap named "*_BYTES" actually bounds bytes.
const BODY_ENCODER = new TextEncoder();

export const DEFAULT_DOMAIN: [number, number] = [-10, 10];
export const CHART_KINDS = ["line", "scatter", "bar"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export interface CompiledFunc {
  label?: string;
  expr: string; // kept for reference/aria derivation is NOT allowed to use it
  fn: (x: number) => number;
}

export interface FunctionSpec {
  type: "function";
  title?: string;
  xlabel?: string;
  ylabel?: string;
  domain: [number, number];
  range?: [number, number];
  funcs: CompiledFunc[];
}

export interface DataSeries {
  label?: string;
  points: Array<[number, number]>;
}

export interface DataSpec {
  type: "data";
  title?: string;
  xlabel?: string;
  ylabel?: string;
  kind: ChartKind;
  categories?: string[];
  data: DataSeries[];
}

export type ChartSpec = FunctionSpec | DataSpec;

// -- small total helpers -----------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Read a key only if the object OWNS it (never via the prototype chain), so a
// '__proto__' value nested in the JSON is inert and inherited props are ignored.
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// A finite [lo, hi] pair with lo < hi, else undefined (caller falls back to
// default/auto). Rejects NaN/Infinity so a bad range never reaches the renderer.
function finitePair(v: unknown): [number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const lo = v[0];
  const hi = v[1];
  if (typeof lo !== "number" || typeof hi !== "number") return undefined;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined;
  if (!(lo < hi)) return undefined;
  return [lo, hi];
}

// -- function-plot branch ----------------------------------------------------

function parseFunctionSpec(
  obj: Record<string, unknown>,
  funcsRaw: unknown,
): FunctionSpec | null {
  if (!Array.isArray(funcsRaw) || funcsRaw.length === 0) return null;

  const funcs: CompiledFunc[] = [];
  for (const item of funcsRaw) {
    if (!isObject(item)) continue;
    const expr = optString(own(item, "expr"));
    if (expr === undefined) continue;
    const fn = compileExpr(expr);
    if (fn === null) continue; // drop a func that fails to compile
    const label = optString(own(item, "label"));
    funcs.push(label !== undefined ? { expr, label, fn } : { expr, fn });
  }
  if (funcs.length === 0) return null; // ALL funcs invalid -> null

  const spec: FunctionSpec = {
    type: "function",
    domain: finitePair(own(obj, "domain")) ?? DEFAULT_DOMAIN,
    funcs,
  };
  const title = optString(own(obj, "title"));
  if (title !== undefined) spec.title = title;
  const xlabel = optString(own(obj, "xlabel"));
  if (xlabel !== undefined) spec.xlabel = xlabel;
  const ylabel = optString(own(obj, "ylabel"));
  if (ylabel !== undefined) spec.ylabel = ylabel;
  const range = finitePair(own(obj, "range"));
  if (range !== undefined) spec.range = range;
  return spec;
}

// -- data-chart branch -------------------------------------------------------

function isKind(v: unknown): v is ChartKind {
  return (
    typeof v === "string" && (CHART_KINDS as readonly string[]).includes(v)
  );
}

function parsePoints(raw: unknown): Array<[number, number]> {
  if (!Array.isArray(raw)) return [];
  const points: Array<[number, number]> = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2) continue;
    const x = p[0];
    const y = p[1];
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue; // skip non-finite
    points.push([x, y]);
  }
  return points;
}

function parseDataSpec(
  obj: Record<string, unknown>,
  dataRaw: unknown,
): DataSpec | null {
  const kind = own(obj, "kind");
  if (!isKind(kind)) return null; // bad/missing kind -> null
  if (!Array.isArray(dataRaw) || dataRaw.length === 0) return null;

  const data: DataSeries[] = [];
  for (const item of dataRaw) {
    if (!isObject(item)) continue;
    const points = parsePoints(own(item, "points"));
    if (points.length === 0) continue; // series with no valid points is dropped
    const label = optString(own(item, "label"));
    data.push(label !== undefined ? { label, points } : { points });
  }
  if (data.length === 0) return null; // no series with finite points -> null

  const spec: DataSpec = { type: "data", kind, data };
  const title = optString(own(obj, "title"));
  if (title !== undefined) spec.title = title;
  const xlabel = optString(own(obj, "xlabel"));
  if (xlabel !== undefined) spec.xlabel = xlabel;
  const ylabel = optString(own(obj, "ylabel"));
  if (ylabel !== undefined) spec.ylabel = ylabel;
  const catsRaw = own(obj, "categories");
  if (Array.isArray(catsRaw)) {
    const categories = catsRaw.filter((c): c is string => typeof c === "string");
    if (categories.length > 0) spec.categories = categories;
  }
  return spec;
}

// -- public entry ------------------------------------------------------------

// Parse a fence body into a normalized ChartSpec, or null. Never throws.
export function parseChartSpec(body: string): ChartSpec | null {
  if (typeof body !== "string") return null;
  // Byte cap: a huge body is rejected before JSON.parse. Measured in real UTF-8
  // bytes (a multibyte body would slip a much larger payload past a UTF-16
  // code-unit check).
  if (BODY_ENCODER.encode(body).length > BODY_MAX_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null; // partial/truncated/invalid JSON mid-stream -> null
  }
  if (!isObject(parsed)) return null;

  const funcsRaw = own(parsed, "funcs");
  const dataRaw = own(parsed, "data");
  const hasFuncs = funcsRaw !== undefined;
  const hasData = dataRaw !== undefined;

  // Exactly one discriminator: funcs wins if present; neither/both-ambiguous
  // resolve per the brief (funcs present -> function plot; else data).
  if (hasFuncs) return parseFunctionSpec(parsed, funcsRaw);
  if (hasData) return parseDataSpec(parsed, dataRaw);
  return null;
}
