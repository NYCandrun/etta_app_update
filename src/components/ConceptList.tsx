import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "./ui";
import { formatModuleLabel } from "../lib/labels";
import { useCurriculumStore } from "../stores/useCurriculumStore";
import type { Concept } from "../types/contract";

// The REAL navigation surface (milestone 4): a grouped, searchable,
// keyboard-navigable list of every concept. Learners start lessons from HERE
// (or "Today's session"), never from the static diagram's nodes. Locked entries
// are conveyed with text + a lock glyph and `aria-disabled`, never color alone
// (blocklist #33); only UNLOCKED / in-progress / completed concepts expose a
// "Start" action.

const STATE_META: Record<
  Concept["state"],
  { label: string; icon: string; className: string }
> = {
  completed: { label: "Completed", icon: "✓", className: "text-success" },
  in_progress: { label: "In progress", icon: "•", className: "text-primary" },
  unlocked: { label: "Available", icon: "○", className: "text-warning" },
  locked: { label: "Locked", icon: "🔒", className: "text-text-muted" },
};

// Domain ordering and display names follow the curriculum source of truth
// (scripts/gen_curriculum.py PHASES / the domain JSONs): the declared order is
// algebra → trigonometry → pre-calculus → … → astrophysics (trigonometry
// comes BEFORE its dependent pre-calculus), and headings use each domain's
// display_name (e.g. "Thermodynamics & Statistical Mechanics", not a
// re-derived "Thermodynamics"). Any domain not listed sorts last,
// alphabetically, so the list never silently drops concepts.
const DOMAIN_META = [
  { id: "algebra", displayName: "Algebra" },
  { id: "trigonometry", displayName: "Trigonometry" },
  { id: "precalculus", displayName: "Pre-Calculus" },
  { id: "single_variable_calculus", displayName: "Single-Variable Calculus" },
  { id: "multivariable_calculus", displayName: "Multivariable Calculus" },
  { id: "linear_algebra", displayName: "Linear Algebra" },
  { id: "differential_equations", displayName: "Differential Equations" },
  { id: "classical_mechanics", displayName: "Classical Mechanics" },
  { id: "electromagnetism", displayName: "Electromagnetism" },
  {
    id: "thermodynamics",
    displayName: "Thermodynamics & Statistical Mechanics",
  },
  { id: "quantum_mechanics", displayName: "Quantum Mechanics" },
  { id: "astrophysics", displayName: "Astrophysics" },
] as const;

function domainRank(domain: string): number {
  const i = DOMAIN_META.findIndex((d) => d.id === domain);
  return i === -1 ? DOMAIN_META.length : i;
}

function domainDisplayName(domain: string): string {
  const meta = DOMAIN_META.find((d) => d.id === domain);
  if (meta) return meta.displayName;
  // Unknown domain: readable fallback derived from the id.
  return domain
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface ConceptListProps {
  className?: string;
  /** Offline coherence (WP3): when `offline`, rows whose lesson the probe
   * confirmed cached stay startable with an "Available offline" hint; all
   * others disable Start with the same message the dashboard CTAs use.
   * `cachedLessonIds === null` means "no verdict yet" (treated as uncached). */
  offline?: boolean;
  cachedLessonIds?: ReadonlySet<string> | null;
}

export function ConceptList({
  className,
  offline = false,
  cachedLessonIds = null,
}: ConceptListProps) {
  const navigate = useNavigate();
  const concepts = useCurriculumStore((s) => s.concepts);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = Object.values(concepts);
    const matched = q
      ? all.filter(
          (c) =>
            c.title.toLowerCase().includes(q) ||
            c.domain.toLowerCase().includes(q) ||
            c.module.toLowerCase().includes(q),
        )
      : all;

    const byDomain = new Map<string, Concept[]>();
    for (const c of matched) {
      const list = byDomain.get(c.domain) ?? [];
      list.push(c);
      byDomain.set(c.domain, list);
    }
    return [...byDomain.entries()]
      .sort((a, b) => domainRank(a[0]) - domainRank(b[0]) || a[0].localeCompare(b[0]))
      .map(([domain, items]) => ({
        domain,
        items: items.sort((a, b) => a.id.localeCompare(b.id)),
      }));
  }, [concepts, query]);

  const total = Object.keys(concepts).length;

  return (
    <div className={className}>
      <label htmlFor="concept-search" className="sr-only">
        Search concepts
      </label>
      <input
        id="concept-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search concepts…"
        className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-text"
      />

      {total === 0 ? (
        <p className="mt-3 text-sm text-text-muted">No concepts loaded yet.</p>
      ) : groups.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted" aria-live="polite">
          No concepts match “{query}”.
        </p>
      ) : (
        <div className="mt-3 space-y-5">
          {groups.map((group) => (
            <section
              key={group.domain}
              aria-label={domainDisplayName(group.domain)}
            >
              <h3 className="text-sm font-semibold text-text-muted">
                {domainDisplayName(group.domain)}
              </h3>
              <ul className="mt-2 divide-y divide-surface-border rounded-lg border border-surface-border">
                {group.items.map((c) => (
                  <ConceptRow
                    key={c.id}
                    concept={c}
                    offline={offline}
                    cachedOffline={cachedLessonIds?.has(c.id) ?? false}
                    onStart={() => navigate(`/lesson/${c.id}`)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ConceptRow({
  concept,
  offline,
  cachedOffline,
  onStart,
}: {
  concept: Concept;
  offline: boolean;
  cachedOffline: boolean;
  onStart: () => void;
}) {
  const meta = STATE_META[concept.state];
  const locked = concept.state === "locked";
  // Offline: only cached lessons stay startable (same rule + message as the
  // dashboard CTAs — the two surfaces must never disagree).
  const startBlocked = offline && !cachedOffline;
  return (
    <li
      className="flex items-center gap-3 px-3 py-2"
      aria-disabled={locked || undefined}
    >
      {/* Status: icon + TEXT, never color alone (#33). The ONE announced
          status per row is the visible "· {label}" in the subtitle below;
          the icon and the right-hand locked marker are aria-hidden so screen
          readers never hear "Locked" two or three times. */}
      <span
        aria-hidden="true"
        className={`flex items-center gap-1 text-xs ${meta.className}`}
      >
        {meta.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text">{concept.title}</p>
        <p className="text-xs text-text-muted">
          {formatModuleLabel(concept.module)} · {meta.label}
          {offline && !locked && cachedOffline ? " · Available offline" : ""}
        </p>
      </div>
      {locked ? (
        <span aria-hidden="true" className="text-xs text-text-muted">
          Locked
        </span>
      ) : (
        <Button
          variant="secondary"
          onClick={onStart}
          disabled={startBlocked}
          aria-disabled={startBlocked || undefined}
          title={startBlocked ? "Lessons need a connection" : undefined}
        >
          Start
        </Button>
      )}
    </li>
  );
}
