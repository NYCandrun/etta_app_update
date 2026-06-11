import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Card, InlineError, OfflineNotice, Skeleton, useToast } from "../components/ui";
import { RichText } from "../components/RichText";
import { ipc, streamGenerate } from "../lib/ipc";
import { useOnline } from "../lib/useOnline";
import { useStudyTimer } from "../lib/useStudyTimer";
import { useGamificationStore } from "../stores/useGamificationStore";
import type { Concept } from "../types/contract";

// The escalation ladder for "I don't get it" — each press advances one rung,
// and each rung is ONE explain-mode call carrying the strategy (Appendix F).
const STRATEGIES = ["textbook", "analogy", "socratic", "scaffold"] as const;
type Strategy = (typeof STRATEGIES)[number];

const STRATEGY_LABEL: Record<Strategy, string> = {
  textbook: "Textbook explanation",
  analogy: "Analogy / visual",
  socratic: "Socratic questioning",
  scaffold: "Scaffold to prerequisite",
};

// Shared max-width so the lesson column matches the quiz column app-wide.
const COLUMN = "mx-auto w-full max-w-2xl";

export function LessonPage() {
  const { conceptId } = useParams();
  const navigate = useNavigate();
  const { showError } = useToast();
  const setGamification = useGamificationStore((s) => s.setState);
  const online = useOnline();
  useStudyTimer();

  const [lesson, setLesson] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [explanation, setExplanation] = useState("");
  const [explaining, setExplaining] = useState(false);
  const [strategyIdx, setStrategyIdx] = useState(0);
  const [xpAwarded, setXpAwarded] = useState(false);
  // Inline (non-native) unsaved-progress confirmation — shown in place of a
  // native window.confirm (blocklist #23: accessible inline messaging only).
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  // CRITICAL (bug 0g): the learner's ACTUAL recent mistakes must reach the
  // reinforcement prompt. We hold them in a ref so the value sent is always the
  // CURRENT one — never an empty array captured by a stale closure at mount.
  const mistakesRef = useRef<string[]>([]);
  // Whether the learner has interacted enough that leaving should warn.
  const dirtyRef = useRef(false);
  // Monotonic token for the active stream. Switching concepts (or re-loading)
  // bumps it; deltas/results from a superseded stream are dropped so a previous
  // concept's late chunks never append into the current concept's lesson
  // (async result landing after the route param changed — blocklist #28).
  const streamGenRef = useRef(0);

  // Load the concept's recent error patterns into the ref, then stream the
  // lesson. The reinforcement context (mistakes) is read from the ref at the
  // moment of the call, not closed over at mount.
  const loadLesson = useCallback(() => {
    if (!conceptId) return;
    const gen = ++streamGenRef.current;
    setLoading(true);
    setLoadError(null);
    setLesson("");

    void ipc.getConceptStates().then(async (res) => {
      if (res.ok) {
        const concept: Concept | undefined = res.data.find((c) => c.id === conceptId);
        mistakesRef.current = concept?.errorPatterns ?? [];
      }
      // Build the reinforcement hint from the CURRENT ref value (bug 0g).
      const mistakes = mistakesRef.current;
      const userInput =
        mistakes.length > 0
          ? `The learner has recently struggled with: ${mistakes.join(", ")}. ` +
            `Reinforce these specifically.`
          : undefined;

      const result = await streamGenerate(
        { conceptId, mode: "lesson", userInput },
        (chunk) => {
          // Drop chunks from a superseded stream (the concept changed mid-stream).
          if (gen === streamGenRef.current) setLesson((prev) => prev + chunk);
        },
      );
      if (gen !== streamGenRef.current) return; // superseded; ignore its result
      if (!result.ok) {
        setLoadError(result.error);
        showError(`Could not load the lesson: ${result.error}`, loadLesson);
      }
      setLoading(false);
    });
  }, [conceptId, showError]);

  useEffect(() => {
    loadLesson();
  }, [loadLesson]);

  // Warn before the browser/window unloads with unsaved progress.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current && !xpAwarded) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [xpAwarded]);

  const handleDontGetIt = useCallback(() => {
    if (!conceptId) return;
    dirtyRef.current = true;
    const gen = ++streamGenRef.current;
    const idx = Math.min(strategyIdx, STRATEGIES.length - 1);
    const strategy: Strategy = STRATEGIES[idx] ?? "textbook";
    setExplaining(true);
    setExplanation("");

    // Reinforcement mistakes are read from the ref at call time (bug 0g): the
    // explain prompt always carries the learner's current detected patterns.
    const mistakes = mistakesRef.current;
    const userInput =
      mistakes.length > 0
        ? `I don't understand. I've struggled with: ${mistakes.join(", ")}.`
        : "I don't understand this yet.";

    void streamGenerate(
      { conceptId, mode: "explain", strategy, userInput },
      (chunk) => {
        if (gen === streamGenRef.current) setExplanation((prev) => prev + chunk);
      },
    ).then((res) => {
      if (gen !== streamGenRef.current) return; // superseded; ignore its result
      setExplaining(false);
      if (!res.ok) {
        showError(`Could not load an explanation: ${res.error}`, handleDontGetIt);
        return;
      }
      setStrategyIdx((i) => Math.min(i + 1, STRATEGIES.length - 1));
    });
  }, [conceptId, strategyIdx, showError]);

  const handleReadyForQuiz = useCallback(() => {
    if (!conceptId) return;
    // Lesson-completion XP is awarded ONCE, by the backend, guarded by a
    // persisted marker — NOT incremented locally and NOT on every click.
    void ipc.awardLessonXp(conceptId).then((res) => {
      if (res.ok) {
        setGamification(res.data);
        setXpAwarded(true);
        dirtyRef.current = false;
        navigate(`/quiz/${conceptId}`);
      } else {
        showError(`Could not record lesson completion: ${res.error}`);
      }
    });
  }, [conceptId, navigate, setGamification, showError]);

  const handleBack = useCallback(() => {
    if (dirtyRef.current && !xpAwarded) {
      setConfirmingLeave(true);
      return;
    }
    navigate(-1);
  }, [navigate, xpAwarded]);

  const confirmLeave = useCallback(() => {
    setConfirmingLeave(false);
    navigate(-1);
  }, [navigate]);

  const cancelLeave = useCallback(() => setConfirmingLeave(false), []);

  const atLastStrategy = strategyIdx >= STRATEGIES.length - 1;
  const currentStrategy: Strategy =
    STRATEGIES[Math.min(strategyIdx, STRATEGIES.length - 1)] ?? "textbook";
  const nextStrategyLabel = STRATEGY_LABEL[currentStrategy];

  return (
    <div className={COLUMN}>
      <div className="mb-4 flex items-center justify-between">
        <Button variant="ghost" onClick={handleBack}>
          ← Back
        </Button>
        <span className="text-sm text-text-muted">Lesson — {conceptId}</span>
      </div>

      {confirmingLeave && (
        <div
          role="alertdialog"
          aria-label="Leave this lesson?"
          className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-text"
        >
          <span className="flex-1">
            Leave this lesson? Your place here won't be saved.
          </span>
          <Button variant="secondary" onClick={cancelLeave}>
            Stay
          </Button>
          <Button onClick={confirmLeave}>Leave</Button>
        </div>
      )}

      <Card>
        {loading && lesson.length === 0 ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : loadError && lesson.length === 0 ? (
          <InlineError message={loadError} onRetry={loadLesson} />
        ) : (
          <RichText content={lesson} className="prose" />
        )}
      </Card>

      {explanation.length > 0 && (
        <Card className="mt-4 border-accent/40">
          <h2 className="mb-2 text-sm font-semibold text-accent">
            {nextStrategyLabel}
          </h2>
          <RichText content={explanation} className="prose" />
        </Card>
      )}

      {!online && (
        <OfflineNotice
          className="mt-4"
          detail="You're offline, so new explanations are paused. The quiz needs a connection too. Reconnect to continue."
        />
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={handleDontGetIt}
          disabled={explaining || loading || !online}
          aria-disabled={!online}
          title={!online ? "Unavailable while offline" : undefined}
        >
          {explaining
            ? "Thinking…"
            : atLastStrategy
              ? "I still don't get it"
              : "I don't get it"}
        </Button>
        <Button
          onClick={handleReadyForQuiz}
          disabled={loading || !online}
          aria-disabled={!online}
          title={!online ? "The quiz needs a connection" : undefined}
        >
          Ready for quiz
        </Button>
      </div>
    </div>
  );
}
