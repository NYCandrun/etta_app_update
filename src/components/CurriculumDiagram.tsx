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

  return (
    <div className={className} style={{ position: "relative" }}>
      {/* Base diagram: build-time SVG, injected as-is (it is OUR generated
          asset, not untrusted content). It carries the title/desc alt text. */}
      <div className="w-full" dangerouslySetInnerHTML={{ __html: mapSvg }} />
      {/* Status-dot overlay: same viewBox so coordinates align exactly. It is
          aria-hidden because the base SVG already describes the curriculum and
          the concept list is the accessible navigation surface. */}
      <svg
        viewBox={`0 0 ${positions.width} ${positions.height}`}
        className="absolute inset-0 h-full w-full"
        aria-hidden="true"
        preserveAspectRatio="xMidYMid meet"
      >
        {dots.map((d) => {
          const unlocked = d.concept?.state === "unlocked";
          const clickable = unlocked && onSelectConcept;
          return (
            <circle
              key={d.id}
              cx={d.cx}
              cy={d.cy}
              r={clickable ? 5 : 3.5}
              fill={dotFill(d.concept?.state)}
              style={clickable ? { cursor: "pointer", pointerEvents: "auto" } : undefined}
              onClick={clickable ? () => onSelectConcept(d.id) : undefined}
            >
              {d.concept && <title>{`${d.concept.title} — ${d.concept.state}`}</title>}
            </circle>
          );
        })}
      </svg>
    </div>
  );
}
