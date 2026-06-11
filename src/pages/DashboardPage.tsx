import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, InlineError, Skeleton, useToast } from "../components/ui";
import { CurriculumDiagram } from "../components/CurriculumDiagram";
import { ConceptList } from "../components/ConceptList";
import { ProgressIndicators } from "../components/ProgressIndicators";
import { ipc } from "../lib/ipc";
import { LABELS } from "../lib/labels";
import { useCurriculumStore } from "../stores/useCurriculumStore";
import type { Concept, DailySession } from "../types/contract";

// The learner home (milestone 4). Top strip = streak / XP / daily-goal ring
// (real tracked minutes, H1) via the shared ProgressIndicators. "Today's
// session" is the M3 session builder (new + due reviews, interleaved, with an
// estimate); tapping "Start Learning" navigates EXACTLY ONCE (H4 — it ONLY
// navigates, it does not also fire an onStart side-effect). The static
// curriculum diagram (#49) is a build-time SVG with a data-driven status-dot
// overlay; learners do NOT start lessons from map nodes — the searchable
// concept list below is the real navigation surface.

export function DashboardPage() {
  const navigate = useNavigate();
  const { showError } = useToast();
  const concepts = useCurriculumStore((s) => s.concepts);
  const setConcepts = useCurriculumStore((s) => s.setConcepts);

  const [session, setSession] = useState<DailySession | null>(null);
  const [statesLoaded, setStatesLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void Promise.all([ipc.buildSession(), ipc.getConceptStates()]).then(
      ([sess, states]) => {
        if (!sess.ok) {
          setError(sess.error);
          showError(`Could not build today's session: ${sess.error}`, load);
          setLoading(false);
          return;
        }
        if (!states.ok) {
          setError(states.error);
          showError(`Could not load your concepts: ${states.error}`, load);
          setLoading(false);
          return;
        }
        setSession(sess.data);
        setConcepts(states.data);
        setStatesLoaded(true);
        setLoading(false);
      },
    );
  }, [showError, setConcepts]);

  useEffect(() => {
    load();
  }, [load]);

  // Title lookup for the session card (buildSession returns ids only).
  const titleOf = useCallback(
    (id: string): string => concepts[id]?.title ?? id,
    [concepts],
  );

  // The first concept of today's interleaved set is where "Start Learning"
  // begins. Prefer a new concept, then a review, then anything in the set.
  const firstConceptId = useMemo(() => {
    if (!session) return null;
    return (
      session.interleavedSet[0] ??
      session.conceptsNew[0] ??
      session.conceptsReview[0] ??
      null
    );
  }, [session]);

  // "Continue where you left off": the most-recent in_progress concept.
  const continueConcept = useMemo<Concept | null>(() => {
    const inProgress = Object.values(concepts).filter(
      (c) => c.state === "in_progress",
    );
    return inProgress[0] ?? null;
  }, [concepts]);

  // H4: navigate EXACTLY ONCE. No second onStart()/side-effect call here.
  const startSession = useCallback(() => {
    if (firstConceptId) navigate(`/lesson/${firstConceptId}`);
  }, [firstConceptId, navigate]);

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Card>
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="mt-3 h-10 w-full" />
          <Skeleton className="mt-2 h-10 w-2/3" />
        </Card>
        <Card>
          <Skeleton className="h-6 w-1/4" />
          <Skeleton className="mt-3 h-40 w-full" />
        </Card>
      </div>
    );
  }

  if (error && !session) {
    return (
      <Card>
        <InlineError message={error} onRetry={load} />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top strip: streak / XP / daily-goal ring (real minutes, H1). */}
      <Card>
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-text">Welcome back</h1>
          <ProgressIndicators />
        </div>
      </Card>

      {/* Today's session (M3 builder): new + due reviews, interleaved. */}
      <Card>
        <h2 className="text-base font-semibold text-text">Today's session</h2>
        {session && (
          <>
            <p className="mt-1 text-sm text-text-muted">
              {session.conceptsNew.length} new ·{" "}
              {session.conceptsReview.length} review · about{" "}
              {session.estimatedMinutes} min
            </p>
            {session.interleavedSet.length > 0 ? (
              <ol className="mt-3 space-y-1 text-sm text-text">
                {session.interleavedSet.slice(0, 6).map((id, i) => (
                  <li key={`${id}-${i}`} className="flex items-center gap-2">
                    <span className="text-text-muted">{i + 1}.</span>
                    <span>{titleOf(id)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 text-sm text-text-muted">
                Nothing scheduled right now — browse concepts below to begin.
              </p>
            )}
            <div className="mt-5 flex items-center justify-between">
              {continueConcept ? (
                <button
                  type="button"
                  onClick={() => navigate(`/lesson/${continueConcept.id}`)}
                  className="rounded text-sm text-primary underline hover:no-underline"
                >
                  Continue where you left off: {continueConcept.title}
                </button>
              ) : (
                <span />
              )}
              <Button onClick={startSession} disabled={!firstConceptId}>
                {LABELS.startLearning}
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* Static curriculum diagram (#49): build-time SVG + status-dot overlay.
          Not a navigation surface — the concept list below is. */}
      <Card>
        <h2 className="text-base font-semibold text-text">Your curriculum</h2>
        <p className="mt-1 text-sm text-text-muted">
          The full path from algebra to astrophysics. Dots show your progress.
        </p>
        <CurriculumDiagram className="mt-4" />
      </Card>

      {/* Browse concepts: the actual searchable, keyboard-navigable surface. */}
      <Card>
        <h2 className="text-base font-semibold text-text">Browse concepts</h2>
        {statesLoaded && <ConceptList className="mt-3" />}
      </Card>
    </div>
  );
}
