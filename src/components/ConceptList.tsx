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

// Domain ordering follows the curriculum phases (algebra → astrophysics). Any
// domain not listed sorts last, alphabetically, so the list never silently
// drops concepts.
const DOMAIN_ORDER = [
  "algebra",
  "precalculus",
  "trigonometry",
  "single_variable_calculus",
  "multivariable_calculus",
  "linear_algebra",
  "differential_equations",
  "classical_mechanics",
  "electromagnetism",
  "thermodynamics",
  "quantum_mechanics",
  "astrophysics",
];

function domainRank(domain: string): number {
  const i = DOMAIN_ORDER.indexOf(domain);
  return i === -1 ? DOMAIN_ORDER.length : i;
}

function prettyDomain(domain: string): string {
  return domain
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface ConceptListProps {
  className?: string;
}

export function ConceptList({ className }: ConceptListProps) {
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
            <section key={group.domain} aria-label={prettyDomain(group.domain)}>
              <h3 className="text-sm font-semibold text-text-muted">
                {prettyDomain(group.domain)}
              </h3>
              <ul className="mt-2 divide-y divide-surface-border rounded-lg border border-surface-border">
                {group.items.map((c) => (
                  <ConceptRow
                    key={c.id}
                    concept={c}
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
  onStart,
}: {
  concept: Concept;
  onStart: () => void;
}) {
  const meta = STATE_META[concept.state];
  const locked = concept.state === "locked";
  return (
    <li
      className="flex items-center gap-3 px-3 py-2"
      aria-disabled={locked || undefined}
    >
      {/* Status: icon + TEXT, never color alone (#33). */}
      <span className={`flex items-center gap-1 text-xs ${meta.className}`}>
        <span aria-hidden="true">{meta.icon}</span>
        <span className="sr-only">{meta.label}: </span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text">{concept.title}</p>
        <p className="text-xs text-text-muted">
          {formatModuleLabel(concept.module)} · {meta.label}
        </p>
      </div>
      {locked ? (
        <span className="text-xs text-text-muted">Locked</span>
      ) : (
        <Button variant="secondary" onClick={onStart}>
          Start
        </Button>
      )}
    </li>
  );
}
