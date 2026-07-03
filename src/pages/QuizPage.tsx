import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Card, InlineError, OfflineNotice, Skeleton, useToast } from "../components/ui";
import { RichText } from "../components/RichText";
import { ApiKeyHint } from "../components/ApiKeyHint";
import { formatIpcError, ipc } from "../lib/ipc";
import { useOnline } from "../lib/useOnline";
import { useStudyTimer } from "../lib/useStudyTimer";
import { LABELS } from "../lib/labels";
import { useCurriculumStore } from "../stores/useCurriculumStore";
import { useGamificationStore } from "../stores/useGamificationStore";
import { useLeaveGuardStore } from "../stores/useLeaveGuardStore";
import type {
  AnswerSubmission,
  GradedAnswer,
  QuizOutcome,
  WireQuestion,
} from "../types/contract";

// ONE shared column max-width for question, feedback, and completion (blocklist
// #14: a single max-width across all three states).
const COLUMN = "mx-auto w-full max-w-2xl";

type Phase = "loading" | "error" | "answering" | "complete";

export function QuizPage() {
  const { conceptId } = useParams();
  const navigate = useNavigate();
  const { showError } = useToast();
  const setGamification = useGamificationStore((s) => s.setState);
  const conceptTitle = useCurriculumStore(
    (s) => (conceptId ? s.concepts[conceptId]?.title : undefined) ?? conceptId,
  );
  const setGuard = useLeaveGuardStore((s) => s.setGuard);
  const clearGuard = useLeaveGuardStore((s) => s.clearGuard);
  const online = useOnline();
  useStudyTimer();

  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<WireQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Inline (non-native) unsaved-progress confirmation for back navigation
  // (blocklist #17 guard, #23 no native dialogs). `pendingLeaveTo` is set when
  // the SIDEBAR triggered the confirmation (the leave guard below) so
  // confirming continues to the link the learner actually clicked.
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [pendingLeaveTo, setPendingLeaveTo] = useState<string | null>(null);

  // CRITICAL (bug 0e + H8): the running answers live in a ref so the FINAL
  // submission includes the LAST answer (a state array read inside the submit
  // handler would be one render stale). They are KEYED by questionId in a Map
  // with replace-on-re-answer semantics: re-running the final handler after a
  // failed submit REPLACES the last answer instead of appending a duplicate,
  // which the backend's exact-permutation gate would reject forever. Latency
  // is folded into each submission (no separately-indexed array to misalign).
  const answersRef = useRef(new Map<string, AnswerSubmission>());
  // Per-question latency: when the current question was first shown.
  const questionShownAtRef = useRef<number>(Date.now());
  // The one-shot persist-retry token from a recorded:false outcome. Server-side
  // it maps to the SERVER-held graded result — retrying never re-grades and
  // never sends graded answers back.
  const retryTokenRef = useRef<string | null>(null);
  // The quiz-instance nonce from generateQuiz. Passed back to
  // gradeAndRecordQuiz so the backend grades EXACTLY the quiz that was served
  // here — a quiz regenerated elsewhere mid-attempt can never displace it.
  const quizIdRef = useRef<string | null>(null);
  // Single-flight guards (verified races): REFS, not state — `submitting`
  // state lands a render late, and toast Retry closures bypass the disabled
  // button entirely, so only a ref checked-and-set at function entry reliably
  // serializes calls. Cleared when the call settles.
  const submitInFlightRef = useRef(false);
  const persistInFlightRef = useRef(false);
  // Mirror of persistInFlightRef for the completion banner's Save button —
  // refs don't re-render, and the button needs a visible disabled state.
  const [saving, setSaving] = useState(false);

  const [result, setResult] = useState<{
    answers: GradedAnswer[];
    finalScore: number;
    recorded: boolean;
  } | null>(null);

  const loadQuiz = useCallback(() => {
    if (!conceptId) return;
    setPhase("loading");
    setLoadError(null);
    void ipc.generateQuiz(conceptId).then((res) => {
      if (!res.ok) {
        // Real error phase (H5): full card with Retry + Back, never a
        // skeleton that shadows it.
        setLoadError(res.error);
        setPhase("error");
        return;
      }
      if (res.data.questions.length === 0) {
        // Guard only — H21 makes an empty quiz near-impossible server-side,
        // but an empty answering screen would be a dead end.
        setLoadError("The quiz came back empty. Retry to generate a fresh one.");
        setPhase("error");
        return;
      }
      setQuestions(res.data.questions);
      quizIdRef.current = res.data.quizId;
      answersRef.current = new Map();
      retryTokenRef.current = null;
      setIndex(0);
      setAnswer("");
      questionShownAtRef.current = Date.now();
      setPhase("answering");
    });
  }, [conceptId]);

  // StrictMode-safe init (dev double-mounts run effects twice): the keyed ref
  // makes generation fire exactly once per concept on mount, while an in-place
  // conceptId change (new route param, same instance) still re-fires. A REAL
  // remount is a fresh component instance with a fresh ref, so it generates
  // again as before. Production behavior is unchanged.
  const generatedForRef = useRef<string | null>(null);
  useEffect(() => {
    const key = conceptId ?? "";
    if (generatedForRef.current === key) return;
    generatedForRef.current = key;
    loadQuiz();
  }, [conceptId, loadQuiz]);

  // Whether this instance is still mounted: toast retry actions outlive the
  // page (toasts render in the root provider), so a retry clicked after
  // navigating away must no-op instead of grading an abandoned quiz.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset the per-question timer whenever a new question is shown.
  useEffect(() => {
    questionShownAtRef.current = Date.now();
  }, [index]);

  // ---- Sidebar leave guard (declarative router: no useBlocker) ----
  // Refs mirror the latest phase/progress so the guard closure (registered
  // once) always checks current values at click time.
  const phaseRef = useRef(phase);
  const progressRef = useRef(false);
  useEffect(() => {
    phaseRef.current = phase;
    progressRef.current = answersRef.current.size > 0 || answer.trim() !== "";
  });

  useEffect(() => {
    const guard = (to: string) => {
      if (phaseRef.current !== "answering" || !progressRef.current) return false;
      setPendingLeaveTo(to);
      setConfirmingLeave(true);
      return true; // blocked — we show the inline confirm instead
    };
    setGuard(guard);
    return () => clearGuard(guard);
  }, [setGuard, clearGuard]);

  const current = questions[index];
  const isLast = index === questions.length - 1;
  const hasFreeResponse = questions.some((q) => q.type === "free_response");

  // Retry ONLY the persist step of an already-graded quiz. Re-entrant calls
  // (double-click, any leftover closure) are a silent no-op via the in-flight
  // ref — the backend token is ONE-SHOT, so a concurrent second call would be
  // told "already saved" right after a successful save. The completion banner
  // is the ONLY affordance for this action (the failure toasts carry no Retry
  // — single source of truth), so no closure that can call this outlives the
  // page. Instance-scoped: the settle handler no-ops if a DIFFERENT quiz
  // instance loaded mid-flight (in-place route change to another concept), so
  // a stale persist can never toast, flip result state, or sync gamification
  // into a new attempt. The backend keeps the SAME token across failed
  // retries, so the ref stays valid.
  const retryPersist = useCallback(() => {
    if (persistInFlightRef.current) return;
    const token = retryTokenRef.current;
    if (!token) return;
    persistInFlightRef.current = true;
    setSaving(true);
    // The quiz instance this persist belongs to, compared again at settle.
    const quizId = quizIdRef.current;
    void ipc.retryPersist(token).then((res) => {
      persistInFlightRef.current = false;
      setSaving(false);
      // A new quiz instance loaded while this persist was in flight: whatever
      // happened server-side belongs to the PREVIOUS instance — never settle
      // its outcome into the current screen.
      if (quizIdRef.current !== quizId) return;
      if (res.ok && res.data.recorded) {
        retryTokenRef.current = null;
        if (res.data.gamification) setGamification(res.data.gamification);
        // The quiz is now recorded — let the completion screen fetch its
        // "Next up" CTA from a fresh session build.
        setResult((prev) => (prev ? { ...prev, recorded: true } : prev));
        return;
      }
      if (res.ok) retryTokenRef.current = res.data.retryToken ?? token;
      // Informational only — the banner (still showing, recorded stayed
      // false) remains the one save affordance.
      showError(
        res.ok
          ? "Could not save your results. Your score still counts on screen — try saving again."
          : `Could not save your results: ${formatIpcError(res.error)}`,
      );
    });
  }, [setGamification, showError]);

  // Handle the merged grade+record outcome: sync gamification when persisted,
  // otherwise keep show-score-anyway and offer a persist-only retry.
  const finishWithOutcome = useCallback(
    (outcome: QuizOutcome) => {
      if (outcome.recorded && outcome.gamification) {
        setGamification(outcome.gamification);
      } else if (!outcome.recorded) {
        retryTokenRef.current = outcome.retryToken;
        // No toast Retry action: the completion banner below carries the ONE
        // save affordance ("Save results"). A toast action here would both
        // race the banner against the one-shot token AND outlive this page —
        // a leftover Retry clicked mid-way through a NEW attempt would fire a
        // persist for the previous instance (verified trace).
        showError(
          "Could not save your results. Your score still counts on screen — try saving again.",
        );
      }
      setResult({
        answers: outcome.perQuestion,
        finalScore: outcome.finalScore,
        recorded: outcome.recorded,
      });
      setPhase("complete");
    },
    [setGamification, showError],
  );

  // Submit the accumulated answers: grade AND persist in one server-side
  // command. The submission array is built FROM the keyed Map, so both the
  // on-page Finish button and the toast retry always submit exactly one
  // answer per question. Named function expression so the retry action can
  // re-arm itself; the toast retry no-ops after unmount (an abandoned quiz
  // must never be graded and persisted from a leftover toast).
  const submitQuiz = useCallback(
    function submit() {
      // Re-entrancy gate FIRST (verified race): `submitting` state re-enables
      // a render late and the toast Retry closure never sees the disabled
      // button, so Finish + a lingering Retry could grade the same quiz twice
      // concurrently. Every submit entry point funnels through here; a second
      // call while one is in flight is a silent no-op.
      if (submitInFlightRef.current) return;
      const quizId = quizIdRef.current;
      if (!conceptId || !quizId) return;
      submitInFlightRef.current = true;
      setSubmitting(true);
      void ipc
        .gradeAndRecordQuiz(conceptId, quizId, Array.from(answersRef.current.values()))
        .then((res) => {
          submitInFlightRef.current = false;
          setSubmitting(false);
          if (!res.ok) {
            showError(`Could not grade the quiz: ${formatIpcError(res.error)}`, () => {
              if (mountedRef.current) submit();
            });
            return;
          }
          finishWithOutcome(res.data);
        });
    },
    [conceptId, showError, finishWithOutcome],
  );

  // Record the current answer (latency folded in) keyed by questionId —
  // re-running this handler for the same question (e.g. clicking Finish again
  // after a failed submit) REPLACES the recorded answer, keeping the handler
  // idempotent — then either advance or submit. Submission reads from the ref
  // so the last answer is always included (bug 0e).
  const handleAdvance = useCallback(() => {
    if (!conceptId || !current) return;
    const latency = Date.now() - questionShownAtRef.current;
    answersRef.current.set(current.id, {
      questionId: current.id,
      answer,
      latencyMs: latency,
    });

    if (!isLast) {
      setIndex((i) => i + 1);
      setAnswer("");
      return;
    }

    // Final question: the ref snapshot now covers every question exactly once
    // (including this last answer — bug 0e).
    submitQuiz();
  }, [conceptId, current, answer, isLast, submitQuiz]);

  const hasProgress = answersRef.current.size > 0 || answer.trim() !== "";

  const handleBack = useCallback(() => {
    if (hasProgress && phase === "answering") {
      setPendingLeaveTo(null);
      setConfirmingLeave(true);
      return;
    }
    navigate(-1);
  }, [hasProgress, phase, navigate]);

  const confirmLeave = useCallback(() => {
    setConfirmingLeave(false);
    const to = pendingLeaveTo;
    setPendingLeaveTo(null);
    if (to) navigate(to);
    else navigate(-1);
  }, [navigate, pendingLeaveTo]);

  const cancelLeave = useCallback(() => {
    setConfirmingLeave(false);
    setPendingLeaveTo(null);
  }, []);

  if (phase === "loading") {
    return (
      <div className={COLUMN}>
        <Card>
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className={COLUMN}>
        <Card>
          <OfflineNotice
            className="mb-3"
            detail="This quiz isn't cached and needs a connection to generate. Reconnect and retry."
          />
          <InlineError
            message={`Could not load the quiz: ${
              loadError ? formatIpcError(loadError) : "unknown error"
            }`}
            onRetry={loadQuiz}
          />
          {loadError && <ApiKeyHint error={loadError} />}
          <div className="mt-4">
            <Button variant="ghost" onClick={() => navigate(-1)}>
              ← Back
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (phase === "complete" && result) {
    return (
      <div className={COLUMN}>
        <QuizComplete
          conceptId={conceptId ?? ""}
          questions={questions}
          answers={result.answers}
          finalScore={result.finalScore}
          recorded={result.recorded}
          onRetrySave={retryTokenRef.current ? retryPersist : undefined}
          saving={saving}
        />
      </div>
    );
  }

  if (!current) return null;

  return (
    <div className={COLUMN}>
      <div className="mb-4 flex items-center justify-between">
        <Button variant="ghost" onClick={handleBack}>
          ← Back
        </Button>
        <span className="text-sm text-text-muted">Quiz — {conceptTitle}</span>
      </div>

      {confirmingLeave && (
        <div
          role="alertdialog"
          aria-label="Leave this quiz?"
          className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-text"
        >
          <span className="flex-1">
            Leave this quiz? Your answers so far won't be saved.
          </span>
          <Button variant="secondary" onClick={cancelLeave}>
            Stay
          </Button>
          <Button onClick={confirmLeave}>Leave</Button>
        </div>
      )}

      <Card>
        <div className="mb-3 flex items-center justify-between text-sm text-text-muted">
          <span>
            Question {index + 1} of {questions.length}
          </span>
          {/* XP indicator sits in the shell header, never over the submit
              controls (blocklist: no overlap with interactive area). */}
        </div>
        <RichText content={current.prompt} className="prose mb-4" />

        <QuestionInput question={current} value={answer} onChange={setAnswer} />

        <OfflineNotice
          className="mt-4"
          detail="You're offline. Grading needs a connection, so submitting is paused. Reconnect to continue."
        />

        <div className="mt-5 flex justify-end">
          <Button
            onClick={handleAdvance}
            disabled={submitting || answer.trim() === "" || !online}
            aria-disabled={!online}
            title={!online ? "Grading needs a connection" : undefined}
          >
            {submitting
              ? // Staged grading label: written answers go to the model
                // concurrently and take noticeably longer than local grading.
                hasFreeResponse
                ? "Checking your written answers…"
                : "Grading…"
              : isLast
                ? LABELS.finishQuiz
                : LABELS.next}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// Renders the input affordance for each of the EXACTLY three allowed types.
function QuestionInput({
  question,
  value,
  onChange,
}: {
  question: WireQuestion;
  value: string;
  onChange: (v: string) => void;
}) {
  if (question.type === "multiple_choice") {
    return (
      <fieldset className="space-y-2">
        <legend className="sr-only">Choose one answer</legend>
        {(question.options ?? []).map((opt) => (
          <label
            key={opt.id}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-surface-border p-3 hover:bg-surface-muted"
          >
            <input
              type="radio"
              name={`q-${question.id}`}
              value={opt.id}
              checked={value === opt.id}
              onChange={() => onChange(opt.id)}
            />
            <RichText content={opt.text} className="prose" />
          </label>
        ))}
      </fieldset>
    );
  }

  if (question.type === "fill_in_blank") {
    const inputId = `answer-${question.id}`;
    return (
      <div className="flex flex-col gap-2">
        <label htmlFor={inputId} className="text-sm font-medium text-text">
          Your answer
        </label>
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-text"
          placeholder="Type your answer"
        />
      </div>
    );
  }

  // free_response
  const textareaId = `answer-${question.id}`;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={textareaId} className="text-sm font-medium text-text">
        Your answer
      </label>
      <textarea
        id={textareaId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-text"
        placeholder="Write your answer"
      />
    </div>
  );
}

// A learner-facing answer: multiple-choice answers arrive as option IDS, which
// mean nothing on screen — map them to the option's display text (which may
// carry LaTeX, so it renders through RichText).
function AnswerDisplay({
  question,
  raw,
}: {
  question: WireQuestion | undefined;
  raw: string;
}) {
  if (raw === "") return <span className="text-text">(blank)</span>;
  if (question?.type === "multiple_choice") {
    const opt = question.options?.find((o) => o.id === raw);
    if (opt) return <RichText content={opt.text} className="prose inline-block align-top" />;
  }
  return <span className="text-text">{raw}</span>;
}

// Completion screen: overall score plus a question-by-question expandable
// review, and — when the quiz was actually recorded — a "Next up" CTA driven
// by a FRESH build_session call (session continuity without a session store).
// Uses the SAME Card + COLUMN max-width as the question view.
function QuizComplete({
  conceptId,
  questions,
  answers,
  finalScore,
  recorded,
  onRetrySave,
  saving,
}: {
  conceptId: string;
  questions: WireQuestion[];
  answers: GradedAnswer[];
  finalScore: number;
  recorded: boolean;
  /** Persist-only retry for a recorded:false outcome. This banner is the ONE
   * save affordance — the failure toast is informational and carries no
   * Retry action (single source of truth; no closure outlives the page). */
  onRetrySave?: () => void;
  /** True while a persist retry is in flight — disables the Save button so a
   * double-click can't race the one-shot backend token. */
  saving?: boolean;
}) {
  const navigate = useNavigate();
  const concepts = useCurriculumStore((s) => s.concepts);
  const [nextUpId, setNextUpId] = useState<string | null>(null);
  const [nextUpFailed, setNextUpFailed] = useState(false);

  useEffect(() => {
    if (!recorded) return;
    let cancelled = false;
    void ipc.buildSession().then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        // Not worth a blocking toast right after finishing a quiz — surface
        // inline below and keep "Back to dashboard" as the primary path.
        setNextUpFailed(true);
        return;
      }
      const queue =
        res.data.interleavedSet.length > 0
          ? res.data.interleavedSet
          : [...res.data.conceptsNew, ...res.data.conceptsReview];
      // Prefer a DIFFERENT concept; a low score can legitimately re-queue this
      // one, in which case "Next up" repeating it is the honest answer.
      const next = queue.find((id) => id !== conceptId) ?? queue[0] ?? null;
      setNextUpId(next);
      setNextUpFailed(false);
    });
    return () => {
      cancelled = true;
    };
  }, [recorded, conceptId]);

  const pct = Math.round(finalScore * 100);
  const correct = answers.filter((a) => a.isCorrect).length;
  const nextUpTitle = nextUpId ? (concepts[nextUpId]?.title ?? nextUpId) : null;

  return (
    <Card>
      <h1 className="text-xl font-semibold text-text">Quiz complete</h1>
      <p className="mt-1 text-sm text-text-muted">
        You scored {pct}% ({correct} of {answers.length} correct).
      </p>

      {/* recorded:false must NOT live only in a 6s toast: this banner stays on
          the completion screen until the save succeeds (retryPersist flips
          `recorded` on success, which clears it and unlocks the Next-up CTA). */}
      {!recorded && (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-text"
        >
          <span className="flex-1">
            Your result isn't saved yet. Your score still counts on screen —
            save it so your progress and streak update.
          </span>
          {onRetrySave && (
            <Button variant="secondary" onClick={onRetrySave} disabled={saving}>
              Save results
            </Button>
          )}
        </div>
      )}

      <div className="mt-4 space-y-2">
        {answers.map((a, i) => {
          const q = questions.find((q) => q.id === a.questionId);
          return (
            <details
              key={a.questionId}
              className="rounded-lg border border-surface-border p-3"
            >
              {/* Correctness is stated as TEXT, never color/glyph alone (#33).
                  The prompt renders through RichText INSIDE the details body —
                  never truncated raw text (which could cut a formula in half
                  and leak literal $...$). */}
              <summary className="cursor-pointer text-sm font-medium text-text">
                Question {i + 1} —{" "}
                <span className={a.isCorrect ? "text-success" : "text-danger"}>
                  <span aria-hidden="true">{a.isCorrect ? "✓" : "✗"}</span>{" "}
                  {a.isCorrect ? "Correct" : "Incorrect"}
                </span>
              </summary>
              <div className="mt-2 space-y-2 text-sm">
                {q && <RichText content={q.prompt} className="prose" />}
                <div>
                  <span className="text-text-muted">Your answer: </span>
                  <AnswerDisplay question={q} raw={a.userAnswer} />
                </div>
                {a.correctAnswer && !a.isCorrect && (
                  <div>
                    <span className="text-text-muted">Correct answer: </span>
                    <RichText content={a.correctAnswer} className="prose" />
                  </div>
                )}
                {a.errorPatternDetected && (
                  <div className="text-warning">
                    Pattern to watch: {a.errorPatternDetected}
                  </div>
                )}
                {a.feedback && (
                  <div>
                    <span className="text-text-muted">Feedback: </span>
                    <RichText content={a.feedback} className="prose" />
                  </div>
                )}
              </div>
            </details>
          );
        })}
      </div>

      {nextUpFailed && (
        <p className="mt-4 text-sm text-text-muted" role="status">
          Couldn't look up what's next — head to your dashboard to continue.
        </p>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button
          variant={nextUpId && nextUpTitle ? "ghost" : "primary"}
          onClick={() => navigate("/dashboard")}
        >
          Back to dashboard
        </Button>
        {nextUpId && nextUpTitle && (
          <Button onClick={() => navigate(`/lesson/${nextUpId}`)}>
            Next up: {nextUpTitle}
          </Button>
        )}
      </div>
    </Card>
  );
}
