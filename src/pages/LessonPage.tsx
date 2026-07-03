import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Card, InlineError, OfflineNotice, Skeleton, useToast } from "../components/ui";
import { RichText } from "../components/RichText";
import { ApiKeyHint } from "../components/ApiKeyHint";
import { formatIpcError, ipc, isCancelledError, streamGenerate } from "../lib/ipc";
import { useOnline } from "../lib/useOnline";
import { useStudyTimer } from "../lib/useStudyTimer";
import { useCurriculumStore } from "../stores/useCurriculumStore";
import { useGamificationStore } from "../stores/useGamificationStore";

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
  const conceptTitle = useCurriculumStore(
    (s) => (conceptId ? s.concepts[conceptId]?.title : undefined) ?? conceptId,
  );
  const online = useOnline();
  useStudyTimer();

  const [lesson, setLesson] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [explanation, setExplanation] = useState("");
  const [explaining, setExplaining] = useState(false);
  const [strategyIdx, setStrategyIdx] = useState(0);
  // The strategy that PRODUCED the explanation currently on screen. The card
  // header derives from THIS — never from strategyIdx, which advances to the
  // NEXT rung on success and would mislabel the visible content.
  const [explanationStrategy, setExplanationStrategy] = useState<Strategy | null>(null);
  // Inline (non-native) unsaved-progress confirmation — shown in place of a
  // native window.confirm (blocklist #23: accessible inline messaging only).
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  // Whether the learner has interacted enough that leaving should warn.
  const dirtyRef = useRef(false);
  // Monotonic token for the active stream. Switching concepts (or re-loading)
  // bumps it; deltas/results from a superseded stream are dropped so a previous
  // concept's late chunks never append into the current concept's lesson
  // (async result landing after the route param changed — blocklist #28).
  // Deltas already arrive on a per-invocation Channel (H7); this guards the
  // component's own superseded setState callbacks.
  const streamGenRef = useRef(0);
  // The active stream's frontend-generated request id. Starting a new stream
  // cancels the previous one; unmount cancels whatever is still running, so an
  // abandoned stream never keeps generating (and billing) server-side (H7).
  const activeRequestIdRef = useRef<string | null>(null);

  const cancelActiveStream = useCallback(() => {
    const active = activeRequestIdRef.current;
    if (active) {
      activeRequestIdRef.current = null;
      void ipc.cancelStream(active);
    }
  }, []);

  // Cancel the in-flight stream when the page unmounts (stable deps — this
  // cleanup runs on unmount only; concept changes cancel inside loadLesson).
  useEffect(() => () => cancelActiveStream(), [cancelActiveStream]);

  // Toast Retry actions outlive the page (toasts render in the root provider
  // and survive navigation), so every retry closure guards on "still mounted
  // AND still the same concept" — a Retry clicked after leaving must never
  // start an orphan stream that nothing can cancel (H7).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const currentConceptRef = useRef(conceptId);
  useEffect(() => {
    currentConceptRef.current = conceptId;
  });

  // Stream the lesson. Reinforcement is decided SERVER-side from the learner's
  // real recent mistakes (C3) — nothing is sent from here.
  const loadLesson = useCallback(() => {
    if (!conceptId) return;
    cancelActiveStream();
    const gen = ++streamGenRef.current;
    const requestId = crypto.randomUUID();
    activeRequestIdRef.current = requestId;
    setLoading(true);
    setLoadError(null);
    setLesson("");
    // Superseding an in-flight explain stream: its .then returns early on the
    // gen mismatch and would leave `explaining` stuck true forever (both
    // action buttons permanently disabled) — this reload owns the reset.
    setExplaining(false);

    void streamGenerate({ requestId, conceptId, mode: "lesson" }, (chunk) => {
      // Drop chunks from a superseded stream (the concept changed mid-stream).
      if (gen === streamGenRef.current) setLesson((prev) => prev + chunk);
    }).then((result) => {
      if (activeRequestIdRef.current === requestId) activeRequestIdRef.current = null;
      if (gen !== streamGenRef.current) return; // superseded; ignore its result
      if (result.ok) {
        // The returned FULL text is authoritative over accumulated deltas —
        // a dropped chunk can never leave a hole in the final lesson.
        setLesson(result.data);
      } else if (!isCancelledError(result.error)) {
        // A cancellation we requested ourselves is not an error to surface.
        setLoadError(result.error);
        showError(`Could not load the lesson: ${formatIpcError(result.error)}`, () => {
          if (!mountedRef.current || currentConceptRef.current !== conceptId) return;
          loadLesson();
        });
      }
      setLoading(false);
    });
  }, [conceptId, showError, cancelActiveStream]);

  useEffect(() => {
    loadLesson();
  }, [loadLesson]);

  // Switching concepts resets the conversational residue: the explanation,
  // the escalation-ladder rung, and the dirty flag belong to the PREVIOUS
  // concept and must never leak under the new one's lesson (loadLesson only
  // resets the lesson stream itself).
  useEffect(() => {
    setExplanation("");
    setExplanationStrategy(null);
    setExplaining(false);
    setStrategyIdx(0);
    setConfirmingLeave(false);
    dirtyRef.current = false;
  }, [conceptId]);

  // Warn before the browser/window unloads with unsaved progress.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const handleDontGetIt = useCallback(() => {
    if (!conceptId) return;
    dirtyRef.current = true;
    cancelActiveStream();
    const gen = ++streamGenRef.current;
    const requestId = crypto.randomUUID();
    activeRequestIdRef.current = requestId;
    const idx = Math.min(strategyIdx, STRATEGIES.length - 1);
    const strategy: Strategy = STRATEGIES[idx] ?? "textbook";
    setExplaining(true);
    setExplanation("");
    // Label the card with the strategy actually DRIVING this stream — the
    // rung index advances on success, so deriving the header from it would
    // caption the content with the NEXT strategy.
    setExplanationStrategy(strategy);

    // Explain stays conversational and uncached: the strategy rung plus the
    // learner's question. (Reinforcement from real mistakes is the LESSON
    // prompt's job, decided server-side — C3.)
    void streamGenerate(
      { requestId, conceptId, mode: "explain", strategy, userInput: "I don't understand this yet." },
      (chunk) => {
        if (gen === streamGenRef.current) setExplanation((prev) => prev + chunk);
      },
    ).then((res) => {
      if (activeRequestIdRef.current === requestId) activeRequestIdRef.current = null;
      // Superseded (a loadLesson reset `explaining` for us; a newer explain
      // set it true for itself) — ignore this stream's result entirely.
      if (gen !== streamGenRef.current) return;
      setExplaining(false);
      if (!res.ok) {
        if (!isCancelledError(res.error)) {
          showError(`Could not load an explanation: ${formatIpcError(res.error)}`, () => {
            if (!mountedRef.current || currentConceptRef.current !== conceptId) return;
            handleDontGetIt();
          });
        }
        return;
      }
      // Full returned text is authoritative over accumulated deltas.
      setExplanation(res.data);
      setStrategyIdx((i) => Math.min(i + 1, STRATEGIES.length - 1));
    });
  }, [conceptId, strategyIdx, showError, cancelActiveStream]);

  const handleReadyForQuiz = useCallback(() => {
    if (!conceptId) return;
    // Lesson-completion XP is awarded ONCE, by the backend, guarded by a
    // persisted marker — NOT incremented locally and NOT on every click.
    // The award is NON-BLOCKING: the learner moves on to the quiz no matter
    // what; a failed award surfaces as a toast (the backend marker keeps a
    // later successful award idempotent).
    dirtyRef.current = false;
    void ipc.awardLessonXp(conceptId).then((res) => {
      if (res.ok) setGamification(res.data);
      else showError(`Could not record lesson completion: ${res.error}`);
    });
    navigate(`/quiz/${conceptId}`);
  }, [conceptId, navigate, setGamification, showError]);

  const handleBack = useCallback(() => {
    if (dirtyRef.current) {
      setConfirmingLeave(true);
      return;
    }
    navigate(-1);
  }, [navigate]);

  const confirmLeave = useCallback(() => {
    setConfirmingLeave(false);
    navigate(-1);
  }, [navigate]);

  const cancelLeave = useCallback(() => setConfirmingLeave(false), []);

  const atLastStrategy = strategyIdx >= STRATEGIES.length - 1;
  // The lesson failed to load and there is nothing on screen to learn from:
  // the ONLY forward action is Retry (in the error card) — "Ready for quiz"
  // and the explain ladder are disabled so a failed load is never a shortcut
  // into a quiz on an unread concept.
  const lessonFailed = loadError !== null && lesson.length === 0;
  // The stream failed MID-lesson: partial text arrived, then the stream died.
  // The truncated text stays readable, but it must never masquerade as a
  // complete lesson — a persistent inline error (with Retry) renders above it
  // and "Ready for quiz" stays disabled until a successful full load.
  const lessonTruncated = loadError !== null && lesson.length > 0;

  return (
    <div className={COLUMN}>
      <div className="mb-4 flex items-center justify-between">
        <Button variant="ghost" onClick={handleBack}>
          ← Back
        </Button>
        <span className="text-sm text-text-muted">Lesson — {conceptTitle}</span>
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
        ) : lessonFailed && loadError ? (
          <>
            <InlineError message={formatIpcError(loadError)} onRetry={loadLesson} />
            <ApiKeyHint error={loadError} />
          </>
        ) : (
          <>
            {lessonTruncated && loadError && (
              <>
                <InlineError
                  className="mb-3"
                  message={`The lesson stopped before finishing: ${formatIpcError(loadError)}`}
                  onRetry={loadLesson}
                />
                <ApiKeyHint error={loadError} />
              </>
            )}
            <RichText content={lesson} className="prose" />
          </>
        )}
      </Card>

      {explanation.length > 0 && (
        <Card className="mt-4 border-accent/40">
          <h2 className="mb-2 text-sm font-semibold text-accent">
            {/* Labeled with the strategy that produced THIS content — the rung
                index has already advanced to the next strategy on success. */}
            {STRATEGY_LABEL[explanationStrategy ?? "textbook"]}
          </h2>
          <RichText content={explanation} className="prose" />
        </Card>
      )}

      <OfflineNotice
        className="mt-4"
        detail="You're offline, so new explanations are paused. The quiz needs a connection too. Reconnect to continue."
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={handleDontGetIt}
          disabled={explaining || loading || lessonFailed || !online}
          aria-disabled={!online}
          title={!online ? "Unavailable while offline" : undefined}
        >
          {explaining
            ? "Thinking…"
            : atLastStrategy
              ? "I still don't get it"
              : "I don't get it"}
        </Button>
        {/* Disabled while the lesson is loading, while it FAILED or arrived
            TRUNCATED (Retry is the only forward path to a complete lesson),
            and while an explanation is still streaming — a deliberate tap
            must not race the in-flight explain stream. */}
        <Button
          onClick={handleReadyForQuiz}
          disabled={loading || explaining || loadError !== null || !online}
          aria-disabled={!online}
          title={!online ? "The quiz needs a connection" : undefined}
        >
          Ready for quiz
        </Button>
      </div>
    </div>
  );
}
