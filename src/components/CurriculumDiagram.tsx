import { useMemo } from "react";
import mapSvg from "../assets/curriculum-map.svg?raw";
import positionsData from "../assets/curriculum-map-positions.json";
import { useCurriculumStore } from "../stores/useCurriculumStore";
import type { Concept } from "../types/contract";

// The static curriculum diagram (blocklist #49). The SVG itself is generated at
// BUILD TIME from the curriculum JSON (scripts/gen_curriculum_svg.mjs) and never
// changes at runtime — there is NO d3, NO runtime graph layout, NO pan/zoom.
// Per-concept progress is overlaid as a thin React-driven dot layer positioned
// from the generated positions map; only the dot COLORS are data-driven, the
// diagram geometry is fixed. The base SVG carries the descriptive alt text (12
// phases); the dots are decorative beyond the per-concept titles in the list
// view, which is the real navigation surface.

interface NodePosition {
  cx: number;
  cy: number;
}
interface PositionsFile {
  width: number;
  height: number;
  positions: Record<string, NodePosition>;
}

const positions = positionsData as PositionsFile;

// Status → dot fill (CSS vars so it themes). Locked concepts get a muted dot;
// state is conveyed by the list view's text/icon too, never color alone (#33).
function dotFill(state: Concept["state"] | undefined): string {
  switch (state) {
    case "completed":
      return "rgb(var(--color-success))";
    case "in_progress":
      return "rgb(var(--color-primary))";
    case "unlocked":
      return "rgb(var(--color-warning))";
    default:
      return "rgb(var(--color-surface-border))";
  }
}

export interface CurriculumDiagramProps {
  className?: string;
  // When set, clicking a node calls back with the concept id (used by the
  // placement "skip — choose where to start" path for UNLOCKED concepts only).
  onSelectConcept?: (conceptId: string) => void;
}

export function CurriculumDiagram({ className, onSelectConcept }: CurriculumDiagramProps) {
  const concepts = useCurriculumStore((s) => s.concepts);

  // One dot per known position. Unknown concepts (no record yet) render as
  // locked/muted dots — the diagram is complete even before states load.
  const dots = useMemo(
    () =>
      Object.entries(positions.positions).map(([id, pos]) => ({
        id,
        cx: pos.cx,
        cy: pos.cy,
        concept: concepts[id],
      })),
    [concepts],
  );

  // Selectable concepts (unlocked, when a select callback exists) get REAL
  // <button> elements in the HTML overlay below — never bare SVG circles.
  const selectable = onSelectConcept
    ? dots.filter(
        (d): d is (typeof dots)[number] & { concept: Concept } =>
          d.concept?.state === "unlocked",
      )
    : [];

  return (
    <div className={className} style={{ position: "relative" }}>
      {/* Base diagram: build-time SVG, injected as-is (it is OUR generated
          asset, not untrusted content). It carries the title/desc alt text. */}
      <div className="w-full" dangerouslySetInnerHTML={{ __html: mapSvg }} />
      {/* Status-dot overlay: same viewBox so coordinates align exactly. It is
          decorative (aria-hidden, no pointer events): the base SVG describes
          the curriculum and the buttons below are the interactive surface. */}
      <svg
        viewBox={`0 0 ${positions.width} ${positions.height}`}
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
        preserveAspectRatio="xMidYMid meet"
      >
        {dots.map((d) => (
          <circle
            key={d.id}
            cx={d.cx}
            cy={d.cy}
            r={d.concept?.state === "unlocked" && onSelectConcept ? 5 : 3.5}
            fill={dotFill(d.concept?.state)}
          />
        ))}
      </svg>
      {/* Interactive overlay: keyboard-focusable buttons with >=24px hit
          targets, positioned by percentage of the (aspect-ratio-locked)
          diagram. NOT aria-hidden — this is the accessible click surface for
          the placement "choose where to start" flow. */}
      {selectable.length > 0 && (
        <div className="pointer-events-none absolute inset-0">
          {selectable.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => onSelectConcept?.(d.id)}
              title={d.concept.title}
              className="pointer-events-auto absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              style={{
                left: `${(d.cx / positions.width) * 100}%`,
                top: `${(d.cy / positions.height) * 100}%`,
              }}
            >
              <span className="sr-only">{`Start ${d.concept.title}`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
