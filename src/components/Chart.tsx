import { Component, useId } from "react";
import type { ReactNode } from "react";
import type {
  ChartSpec,
  DataSpec,
  FunctionSpec,
} from "../lib/chartSpec";

// Inline-SVG renderer for a validated `etta-chart` spec. 100% React elements —
// NO dangerouslySetInnerHTML (the app's only injected HTML stays the
// DOMPurify-sanitized KaTeX in RichText/MathSpan). Colors come from semantic
// tokens via rgb(var(--color-*)) exactly like ProgressIndicators /
// CurriculumDiagram, so both themes re-color for free. Series are ALSO
// distinguished by a dash pattern + legend, so color is never the sole channel.
//
// Accessibility: <svg role="img"> labelled by a <title>/<desc> pair (useId ids)
// whose text is DERIVED deterministically from the spec's shape — kind, series
// labels, axis labels, visible domain/range — and NEVER the raw expr / LaTeX /
// JSON. A ChartErrorBoundary wraps the renderer so any unforeseen throw degrades
// to a readable code block instead of blanking the lesson.

const W = 640;
const H = 400;
const M = { top: 28, right: 20, bottom: 44, left: 56 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
const SAMPLES = 240; // fixed sample count per function
// A function sample this far outside the y-window is treated as a gap (starts a
// new subpath) so 1/x near 0 doesn't draw a false vertical asymptote line.
const Y_CLAMP_FACTOR = 4;

// Token color cycle (semantic tokens only) + a distinct dash per series index.
// The color and dash cycles are CO-PRIME (5 colors, 4 dashes => lcm 20) so the
// (color, dash) pair stays unique across the first 20 series instead of the two
// channels advancing in lockstep and colliding every 5.
const SERIES_COLORS = ["primary", "accent", "success", "warning", "danger"];
const DASHES = ["", "6 4", "2 4", "8 3 2 3"];
// Per-series marker shape for scatter (color-independent channel), and a filled
// hatch angle for bars — both cycle by series index so series stay separable in
// grayscale / for color-blind readers, not by hue alone.
const SHAPES = ["circle", "square", "triangle", "diamond", "cross"] as const;
type Shape = (typeof SHAPES)[number];

function seriesColor(i: number): string {
  return `rgb(var(--color-${SERIES_COLORS[i % SERIES_COLORS.length]}))`;
}
function seriesDash(i: number): string | undefined {
  const d = DASHES[i % DASHES.length];
  return d === "" ? undefined : d;
}
function seriesShape(i: number): Shape {
  return SHAPES[i % SHAPES.length] as Shape;
}

const AXIS = "rgb(var(--color-surface-border))";
const LABEL = "rgb(var(--color-text-muted))";

// -- number formatting -------------------------------------------------------

// Compact tick label: exponential for very large/small magnitudes (astro
// values), otherwise a trimmed fixed form. STEP-AWARE: when a tick `step` is
// passed, decimal precision tracks the step so sub-0.01 ticks (0.005, 0.002)
// render their true value instead of rounding to a hardcoded 2 decimals. Calls
// without a step (rangeText / a11y text) keep the 2-decimal default.
function fmt(v: number, step?: number): string {
  if (!Number.isFinite(v)) return "";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e5 || abs < 1e-4) return v.toExponential(1);
  const decimals =
    step && step > 0 && Number.isFinite(step)
      ? Math.max(0, Math.min(6, -Math.floor(Math.log10(step))))
      : 2;
  let s = v.toFixed(decimals);
  if (s.includes(".")) s = s.replace(/\.?0+$/, "");
  // Normalize negative zero via the NUMERIC value (not a string test) so
  // "-0", "-0.0", etc. collapse to "0".
  return Number(s) === 0 ? "0" : s;
}

interface Ticks {
  vals: number[];
  step: number;
}

// "Nice" tick step (~5 ticks) for [lo, hi]. Returns the tick values AND the step
// (so callers can pass the step into fmt for step-aware precision).
function ticks(lo: number, hi: number, count = 5): Ticks {
  if (!(hi > lo)) return { vals: [lo], step: 0 };
  const span = hi - lo;
  const rawStep = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceNorm = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  const step = niceNorm * mag;
  const start = Math.ceil(lo / step) * step;
  const vals: number[] = [];
  for (let t = start; t <= hi + step * 1e-9 && vals.length < 50; t += step) {
    // Snap away tiny fp dust so "-0" and 2.0000000001 print clean.
    vals.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  }
  return { vals, step };
}

// -- linear scale ------------------------------------------------------------

interface Scale {
  x: (v: number) => number;
  y: (v: number) => number;
  xdom: [number, number];
  ydom: [number, number];
}

// Guard a degenerate axis (min == max) by expanding to a unit interval.
function expand(lo: number, hi: number): [number, number] {
  if (hi > lo) return [lo, hi];
  if (lo === 0) return [-1, 1];
  const pad = Math.abs(lo) || 1;
  return [lo - pad, hi + pad];
}

function makeScale(
  xdomIn: [number, number],
  ydomIn: [number, number],
): Scale {
  const xdom = expand(xdomIn[0], xdomIn[1]);
  const ydom = expand(ydomIn[0], ydomIn[1]);
  const [x0, x1] = xdom;
  const [y0, y1] = ydom;
  return {
    xdom,
    ydom,
    x: (v) => M.left + ((v - x0) / (x1 - x0)) * PLOT_W,
    // SVG y grows downward, so invert.
    y: (v) => M.top + (1 - (v - y0) / (y1 - y0)) * PLOT_H,
  };
}

// -- function sampling -> subpaths -------------------------------------------

// Sample one compiled fn across the domain and build an SVG path `d` that STARTS
// A NEW SUBPATH (M) after any non-finite or far-out-of-window sample, so
// discontinuities (1/x, tan poles, ln/sqrt domain edges) render as separate
// branches with NO false vertical connector. Also returns the finite in-window
// y-samples for auto-range fitting.
function samplePath(
  fn: (x: number) => number,
  xdom: [number, number],
  scale: Scale,
  yWindow: [number, number] | null,
): string {
  const [x0, x1] = xdom;
  let d = "";
  let penDown = false;
  const [ylo, yhi] =
    yWindow ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  const yspan = yWindow ? yhi - ylo : Infinity;
  const guard = yWindow ? yspan * Y_CLAMP_FACTOR : Infinity;
  for (let i = 0; i <= SAMPLES; i += 1) {
    const xv = x0 + ((x1 - x0) * i) / SAMPLES;
    const yv = fn(xv);
    const inWindow =
      Number.isFinite(yv) && yv >= ylo - guard && yv <= yhi + guard;
    if (!inWindow) {
      penDown = false; // gap -> next finite sample opens a new subpath
      continue;
    }
    const px = scale.x(xv);
    const py = scale.y(yv);
    d += `${penDown ? "L" : "M"}${px.toFixed(2)} ${py.toFixed(2)} `;
    penDown = true;
  }
  return d.trim();
}

// Collect finite in-domain y-samples across all funcs for auto-range.
function autoYRange(funcs: FunctionSpec["funcs"], xdom: [number, number]): [number, number] {
  const [x0, x1] = xdom;
  const ys: number[] = [];
  for (const f of funcs) {
    for (let i = 0; i <= SAMPLES; i += 1) {
      const xv = x0 + ((x1 - x0) * i) / SAMPLES;
      const yv = f.fn(xv);
      if (Number.isFinite(yv)) ys.push(yv);
    }
  }
  if (ys.length === 0) return [-1, 1];
  ys.sort((a, b) => a - b);
  // Trim extreme tails so a single near-asymptote sample doesn't flatten the
  // curve; use 2nd/98th percentiles, then pad.
  const lo = ys[Math.floor(ys.length * 0.02)] as number;
  const hi = ys[Math.floor(ys.length * 0.98)] as number;
  const [elo, ehi] = expand(lo, hi);
  const pad = (ehi - elo) * 0.05;
  return [elo - pad, ehi + pad];
}

// -- derived a11y text (NEVER the raw expr/JSON) -----------------------------

function rangeText(lo: number, hi: number): string {
  return `[${fmt(lo)}, ${fmt(hi)}]`;
}

function functionAltText(spec: FunctionSpec, ydom: [number, number]): string {
  const n = spec.funcs.length;
  const labels = spec.funcs
    .map((f, i) => f.label ?? `curve ${i + 1}`)
    .join(", ");
  const noun = n === 1 ? "1 function" : `${n} functions`;
  const axes =
    spec.xlabel || spec.ylabel
      ? ` Axes: x is ${spec.xlabel ?? "x"}, y is ${spec.ylabel ?? "y"}.`
      : "";
  return (
    `Graph of ${noun} over x in ${rangeText(spec.domain[0], spec.domain[1])}, ` +
    `y in ${rangeText(ydom[0], ydom[1])}. Curves: ${labels}.${axes}`
  );
}

function dataAltText(spec: DataSpec): string {
  const kindWord =
    spec.kind === "bar" ? "Bar" : spec.kind === "scatter" ? "Scatter" : "Line";
  const series = spec.data
    .map((s, i) => {
      const nm = s.label ?? `series ${i + 1}`;
      return `${nm} (${s.points.length} points)`;
    })
    .join(", ");
  const axes = `X: ${spec.xlabel ?? "x"}, Y: ${spec.ylabel ?? "y"}.`;
  return `${kindWord} chart. ${axes} Series: ${series}.`;
}

// -- sub-renderers -----------------------------------------------------------

function Axes({
  scale,
  xlabel,
  ylabel,
  hideXTicks = false,
}: {
  scale: Scale;
  xlabel?: string;
  ylabel?: string;
  hideXTicks?: boolean;
}) {
  // Bar charts position bars by integer index, not by any x-value, so their
  // [0,1] placeholder x-domain would draw meaningless decimal ticks; hideXTicks
  // suppresses the x-tick + x-gridline map while keeping the frame, y-axis, and
  // axis-label text.
  const xtk = hideXTicks ? { vals: [], step: 0 } : ticks(scale.xdom[0], scale.xdom[1]);
  const ytk = ticks(scale.ydom[0], scale.ydom[1]);
  return (
    <g aria-hidden="true">
      {/* gridlines + tick labels */}
      {xtk.vals.map((t) => (
        <g key={`x${t}`}>
          <line
            x1={scale.x(t)}
            y1={M.top}
            x2={scale.x(t)}
            y2={M.top + PLOT_H}
            stroke={AXIS}
            strokeWidth={1}
            opacity={0.4}
          />
          <text
            x={scale.x(t)}
            y={M.top + PLOT_H + 16}
            fill={LABEL}
            fontSize={11}
            textAnchor="middle"
          >
            {fmt(t, xtk.step)}
          </text>
        </g>
      ))}
      {ytk.vals.map((t) => (
        <g key={`y${t}`}>
          <line
            x1={M.left}
            y1={scale.y(t)}
            x2={M.left + PLOT_W}
            y2={scale.y(t)}
            stroke={AXIS}
            strokeWidth={1}
            opacity={0.4}
          />
          <text
            x={M.left - 8}
            y={scale.y(t) + 4}
            fill={LABEL}
            fontSize={11}
            textAnchor="end"
          >
            {fmt(t, ytk.step)}
          </text>
        </g>
      ))}
      {/* axis frame */}
      <rect
        x={M.left}
        y={M.top}
        width={PLOT_W}
        height={PLOT_H}
        fill="none"
        stroke={AXIS}
        strokeWidth={1}
      />
      {xlabel && (
        <text
          x={M.left + PLOT_W / 2}
          y={H - 6}
          fill={LABEL}
          fontSize={12}
          textAnchor="middle"
        >
          {xlabel}
        </text>
      )}
      {ylabel && (
        <text
          x={14}
          y={M.top + PLOT_H / 2}
          fill={LABEL}
          fontSize={12}
          textAnchor="middle"
          transform={`rotate(-90 14 ${M.top + PLOT_H / 2})`}
        >
          {ylabel}
        </text>
      )}
    </g>
  );
}

// A filled per-series marker centered at (cx, cy). The SHAPE is a
// color-independent channel (circle/square/triangle/diamond/cross cycling by
// series index) so scatter series stay separable in grayscale / for color-blind
// readers. Used by both the scatter marks and the matching legend swatch.
function ShapeMark({
  shape,
  cx,
  cy,
  r,
  fill,
}: {
  shape: Shape;
  cx: number;
  cy: number;
  r: number;
  fill: string;
}) {
  switch (shape) {
    case "square":
      return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill={fill} />;
    case "triangle":
      return (
        <polygon
          points={`${cx},${cy - r} ${cx + r},${cy + r} ${cx - r},${cy + r}`}
          fill={fill}
        />
      );
    case "diamond":
      return (
        <polygon
          points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
          fill={fill}
        />
      );
    case "cross":
      return (
        <path
          d={`M${cx - r} ${cy} H${cx + r} M${cx} ${cy - r} V${cy + r}`}
          stroke={fill}
          strokeWidth={2}
          fill="none"
        />
      );
    case "circle":
    default:
      return <circle cx={cx} cy={cy} r={r} fill={fill} />;
  }
}

// Per-series hatch angle so bars carry a color-independent channel too. Emitted
// as <pattern> elements into <defs> with useId-namespaced ids (`hatchPrefix`) so
// multiple charts on one page never collide.
const HATCH_ANGLES = [0, 45, 90, 135, 22];
function hatchId(prefix: string, i: number): string {
  return `${prefix}-hatch-${i}`;
}
function BarHatchDefs({ prefix, count }: { prefix: string; count: number }) {
  return (
    <defs>
      {Array.from({ length: count }, (_, i) => {
        const angle = HATCH_ANGLES[i % HATCH_ANGLES.length] as number;
        const color = seriesColor(i);
        return (
          <pattern
            key={i}
            id={hatchId(prefix, i)}
            patternUnits="userSpaceOnUse"
            width={6}
            height={6}
            patternTransform={`rotate(${angle})`}
          >
            <rect width={6} height={6} fill={color} opacity={0.18} />
            <line x1={0} y1={0} x2={0} y2={6} stroke={color} strokeWidth={2} />
          </pattern>
        );
      })}
    </defs>
  );
}

// Legend swatch mode: which mark type the swatch should mimic so the key agrees
// with the plotted marks.
type SwatchKind = "line" | "scatter" | "bar";

function Legend({
  items,
  kind = "line",
  hatchPrefix = "",
}: {
  items: Array<{ label: string; index: number }>;
  kind?: SwatchKind;
  hatchPrefix?: string;
}) {
  if (items.length === 0) return null;
  return (
    <g aria-hidden="true">
      {items.map((it, k) => {
        const y = M.top + 4 + k * 16;
        const x = M.left + PLOT_W - 120;
        let swatch: ReactNode;
        if (kind === "scatter") {
          swatch = (
            <ShapeMark
              shape={seriesShape(it.index)}
              cx={x + 11}
              cy={y}
              r={4}
              fill={seriesColor(it.index)}
            />
          );
        } else if (kind === "bar") {
          swatch = (
            <rect
              x={x}
              y={y - 5}
              width={22}
              height={10}
              fill={hatchPrefix ? `url(#${hatchId(hatchPrefix, it.index)})` : seriesColor(it.index)}
              stroke={seriesColor(it.index)}
              strokeWidth={1}
            />
          );
        } else {
          swatch = (
            <line
              x1={x}
              y1={y}
              x2={x + 22}
              y2={y}
              stroke={seriesColor(it.index)}
              strokeWidth={2}
              strokeDasharray={seriesDash(it.index)}
            />
          );
        }
        return (
          <g key={it.index}>
            {swatch}
            <text x={x + 28} y={y + 4} fill={LABEL} fontSize={11}>
              {it.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function FunctionPlot({ spec }: { spec: FunctionSpec }) {
  const ydom: [number, number] = spec.range ?? autoYRange(spec.funcs, spec.domain);
  const scale = makeScale(spec.domain, ydom);
  const legend = spec.funcs.map((f, i) => ({
    label: f.label ?? `f${i + 1}(x)`,
    index: i,
  }));
  return (
    <>
      <Axes scale={scale} xlabel={spec.xlabel} ylabel={spec.ylabel} />
      {spec.funcs.map((f, i) => (
        <path
          key={i}
          d={samplePath(f.fn, spec.domain, scale, ydom)}
          fill="none"
          stroke={seriesColor(i)}
          strokeWidth={2}
          strokeDasharray={seriesDash(i)}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      <Legend items={legend} />
    </>
  );
}

// Compute x/y data extents across all series.
function dataExtent(data: DataSpec["data"]): {
  xdom: [number, number];
  ydom: [number, number];
} {
  let xlo = Infinity;
  let xhi = -Infinity;
  let ylo = Infinity;
  let yhi = -Infinity;
  for (const s of data) {
    for (const [x, y] of s.points) {
      if (x < xlo) xlo = x;
      if (x > xhi) xhi = x;
      if (y < ylo) ylo = y;
      if (y > yhi) yhi = y;
    }
  }
  return { xdom: [xlo, xhi], ydom: [ylo, yhi] };
}

function DataChart({ spec }: { spec: DataSpec }) {
  const legend = spec.data.map((s, i) => ({
    label: s.label ?? `series ${i + 1}`,
    index: i,
  }));

  if (spec.kind === "bar") {
    return <BarChart spec={spec} legend={legend} />;
  }

  const { xdom, ydom } = dataExtent(spec.data);
  // Pad y a touch so points aren't glued to the frame.
  const [ey0, ey1] = expand(ydom[0], ydom[1]);
  const pad = (ey1 - ey0) * 0.08;
  const scale = makeScale(xdom, [ey0 - pad, ey1 + pad]);

  return (
    <>
      <Axes scale={scale} xlabel={spec.xlabel} ylabel={spec.ylabel} />
      {spec.data.map((s, i) => {
        if (spec.kind === "scatter") {
          // Per-series SHAPE (color-independent) so series are distinguishable
          // without relying on hue alone.
          const shape = seriesShape(i);
          return (
            <g key={i}>
              {s.points.map(([x, y], j) => (
                <ShapeMark
                  key={j}
                  shape={shape}
                  cx={scale.x(x)}
                  cy={scale.y(y)}
                  r={3.5}
                  fill={seriesColor(i)}
                />
              ))}
            </g>
          );
        }
        // line
        const d = s.points
          .map(([x, y], j) => `${j === 0 ? "M" : "L"}${scale.x(x).toFixed(2)} ${scale.y(y).toFixed(2)}`)
          .join(" ");
        return (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={seriesColor(i)}
            strokeWidth={2}
            strokeDasharray={seriesDash(i)}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
      <Legend items={legend} kind={spec.kind === "scatter" ? "scatter" : "line"} />
    </>
  );
}

// Bar chart: categories (or x-index) on the x-axis, grouped bars per series.
function BarChart({
  spec,
  legend,
}: {
  spec: DataSpec;
  legend: Array<{ label: string; index: number }>;
}) {
  // useId-namespaced hatch-pattern ids so per-series fills never collide across
  // multiple charts on one page.
  const hatchPrefix = useId();
  const groupCount = Math.max(
    ...spec.data.map((s) => s.points.length),
    spec.categories?.length ?? 0,
  );
  let ylo = 0;
  let yhi = -Infinity;
  for (const s of spec.data) {
    for (const [, y] of s.points) {
      if (y < ylo) ylo = y;
      if (y > yhi) yhi = y;
    }
  }
  if (!(yhi > ylo)) yhi = ylo + 1;
  const pad = (yhi - ylo) * 0.08;
  const scale = makeScale([0, 1], [ylo, yhi + pad]);
  const y0px = scale.y(Math.max(0, ylo));

  const groupWidth = PLOT_W / Math.max(1, groupCount);
  const seriesCount = spec.data.length;
  const barWidth = (groupWidth * 0.7) / Math.max(1, seriesCount);

  return (
    <>
      {/* Bars are positioned by integer index, so suppress the placeholder
          decimal x-axis (which would overlap the category labels). */}
      <Axes scale={scale} xlabel={spec.xlabel} ylabel={spec.ylabel} hideXTicks />
      <BarHatchDefs prefix={hatchPrefix} count={seriesCount} />
      {spec.data.map((s, si) =>
        s.points.map(([, y], gi) => {
          const groupLeft = M.left + gi * groupWidth + groupWidth * 0.15;
          const x = groupLeft + si * barWidth;
          const yTop = scale.y(y);
          const height = Math.abs(yTop - y0px);
          return (
            // Per-series hatch fill (color-independent) + a solid series-color
            // outline so bars stay separable in grayscale / for color-blind
            // readers, not by hue alone.
            <rect
              key={`${si}-${gi}`}
              x={x}
              y={Math.min(yTop, y0px)}
              width={barWidth}
              height={height}
              fill={`url(#${hatchId(hatchPrefix, si)})`}
              stroke={seriesColor(si)}
              strokeWidth={1}
            />
          );
        }),
      )}
      {/* category labels under each group */}
      {spec.categories && (
        <g aria-hidden="true">
          {spec.categories.slice(0, groupCount).map((c, gi) => (
            <text
              key={gi}
              x={M.left + gi * groupWidth + groupWidth / 2}
              y={M.top + PLOT_H + 16}
              fill={LABEL}
              fontSize={11}
              textAnchor="middle"
            >
              {c}
            </text>
          ))}
        </g>
      )}
      <Legend items={legend} kind="bar" hatchPrefix={hatchPrefix} />
    </>
  );
}

// -- top-level chart ---------------------------------------------------------

function ChartInner({ spec }: { spec: ChartSpec }) {
  const titleId = useId();
  const descId = useId();

  let alt: string;
  let body: ReactNode;
  if (spec.type === "function") {
    const ydom = spec.range ?? autoYRange(spec.funcs, spec.domain);
    alt = functionAltText(spec, ydom);
    body = <FunctionPlot spec={spec} />;
  } else {
    alt = dataAltText(spec);
    body = <DataChart spec={spec} />;
  }
  const heading = spec.title ?? (spec.type === "function" ? "Function graph" : "Chart");

  return (
    <div className="etta-chart-wrap">
      <svg
        role="img"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="auto"
        aria-labelledby={`${titleId} ${descId}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={titleId}>{heading}</title>
        <desc id={descId}>{alt}</desc>
        {spec.title && (
          <text
            x={W / 2}
            y={16}
            fill={LABEL}
            fontSize={13}
            fontWeight={600}
            textAnchor="middle"
            aria-hidden="true"
          >
            {spec.title}
          </text>
        )}
        {body}
      </svg>
    </div>
  );
}

// Error boundary: any unforeseen throw in the renderer degrades to the raw
// fence body as a readable code block, never a blank lesson. Given a spec is
// already validated total, this is belt-and-suspenders.
//
// Re-stream safety: React never clears error-boundary state on a plain
// re-render, so without a reset a boundary that once caught a throw would stay
// latched on `fallback` forever — even after the streamed body grows into a
// fresh valid spec. `resetKey` fixes that: pass a value that is stable per spec
// but changes when the content changes (e.g. the raw fence body), and
// getDerivedStateFromProps clears `failed` on the next render whose resetKey
// differs, so the boundary retries the (now valid) child instead of showing
// stale raw JSON.
interface BoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
  // Stable-per-spec identity of the streamed content; a change clears `failed`.
  resetKey?: unknown;
}
interface BoundaryState {
  failed: boolean;
  // Last resetKey we reconciled against, so we only clear `failed` on a change.
  lastKey: unknown;
}
export class ChartErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false, lastKey: props.resetKey };
  }
  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    // Content changed since we last rendered -> drop the stale failed latch and
    // give the fresh child a chance to render.
    if (props.resetKey !== state.lastKey) {
      return { failed: false, lastKey: props.resetKey };
    }
    return null;
  }
  render(): ReactNode {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

export function Chart({ spec }: { spec: ChartSpec }) {
  return <ChartInner spec={spec} />;
}
