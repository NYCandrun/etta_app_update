import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Card, InlineError, OfflineNotice, Skeleton, useToast } from "../components/ui";
import { RichText } from "../components/RichText";
import { ipc } from "../lib/ipc";
import type { SubmittedAnswer } from "../lib/ipc";
import { useOnline } from "../lib/useOnline";
import { useStudyTimer } from "../lib/useStudyTimer";
import { LABELS } from "../lib/labels";
import { useGamificationStore } from "../stores/useGamificationStore";
import type { GradedAnswer, Question } from "../types/contract";

// ONE shared column max-width for question, feedback, and completion (blocklist
// #14: a single max-width across all three states).
const COLUMN = "mx-auto w-full max-w-2xl";

type Phase = "loading" | "answering" | "complete";

export function QuizPage() {
  const { conceptId } = useParams();
  const navigate = useNavigate();
  const { showError } = useToast();
  const setGamification = useGamificationStore((s) => s.setState);
  const online = useOnline();
  useStudyTimer();

  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Inline (non-native) unsaved-progress confirmation for back navigation
  // (blocklist #17 guard, #23 no native dialogs).
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  // CRITICAL (bug 0e): the running answer list lives in a ref so the FINAL
  // submission includes the LAST answer. A state array read inside the submit
  // handler would be one render stale; the ref is always current.
  const answersRef = useRef<SubmittedAnswer[]>([]);
  // Per-question latency: when the current question was first shown.
  const questionShownAtRef = useRef<number>(Date.now());
  const latenciesRef = useRef<(number | null)[]>([]);

  const [result, setResult] = useState<{
    answers: GradedAnswer[];
    finalScore: number;
  } | null>(null);

  const loadQuiz = useCallback(() => {
    if (!conceptId) return;
    setPhase("loading");
    setLoadError(null);
    void ipc.generateQuiz(conceptId).then((res) => {
      if (!res.ok) {
        setLoadError(res.error);
        showError(`Could not load the quiz: ${res.error}`, loadQuiz);
        return;
      }
      setQuestions(res.data);
      answersRef.current = [];
      latenciesRef.current = [];
      setIndex(0);
      setAnswer("");
      questionShownAtRef.current = Date.now();
      setPhase("answering");
    });
  }, [conceptId, showError]);

  useEffect(() => {
    loadQuiz();
  }, [loadQuiz]);

  // Reset the per-question timer whenever a new question is shown.
  useEffect(() => {
    questionShownAtRef.current = Date.now();
  }, [index]);

  const current = questions[index];
  const isLast = index === questions.length - 1;

  // Record the current answer + latency into the refs, then either advance or
  // grade. Grading reads from the ref so the last answer is always included.
  const handleCheckAnswer = useCallback(() => {
    if (!conceptId || !current) return;
    const latency = Date.now() - questionShownAtRef.current;
    answersRef.current = [
      ...answersRef.current,
      { questionId: current.id, answer },
    ];
    latenciesRef.current = [...latenciesRef.current, latency];

    if (!isLast) {
      setIndex((i) => i + 1);
      setAnswer("");
      return;
    }

    // Final question: grade the WHOLE quiz server-side from the ref snapshot
    // (which includes this last answer — bug 0e), then persist + award XP.
    setSubmitting(true);
    void ipc.gradeQuiz(conceptId, answersRef.current).then((graded) => {
      if (!graded.ok) {
        setSubmitting(false);
        showError(`Could not grade the quiz: ${graded.error}`, handleCheckAnswer);
        return;
      }
      // Persist + advance adaptive state. Latencies align with the graded
      // answers by question order.
      void ipc
        .recordQuizResult(conceptId, graded.data.answers, latenciesRef.current)
        .then((rec) => {
          setSubmitting(false);
          if (!rec.ok) {
            showError(`Could not save your results: ${rec.error}`);
            // Still show the score even if persistence failed.
          } else {
            setGamification(rec.data.gamification);
          }
          setResult({
            answers: graded.data.answers,
            finalScore: graded.data.finalScore,
          });
          setPhase("complete");
        });
    });
  }, [conceptId, current, answer, isLast, showError, setGamification]);

  const hasProgress = answersRef.current.length > 0 || answer.trim() !== "";

  const handleBack = useCallback(() => {
    if (hasProgress && phase === "answering") {
      setConfirmingLeave(true);
      return;
    }
    navigate(-1);
  }, [hasProgress, phase, navigate]);

  const confirmLeave = useCallback(() => {
    setConfirmingLeave(false);
    navigate(-1);
  }, [navigate]);

  const cancelLeave = useCallback(() => setConfirmingLeave(false), []);

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

  if (loadError && questions.length === 0) {
    return (
      <div className={COLUMN}>
        <Card>
          {!online && (
            <OfflineNotice
              className="mb-3"
              detail="This quiz isn't cached and needs a connection to generate. Reconnect and retry."
            />
          )}
          <InlineError message={loadError} onRetry={loadQuiz} />
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
          onDone={() => navigate("/dashboard")}
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
        <span className="text-sm text-text-muted">Quiz — {conceptId}</span>
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

        {!online && (
          <OfflineNotice
            className="mt-4"
            detail="You're offline. Grading needs a connection, so submitting is paused. Reconnect to continue."
          />
        )}

        <div className="mt-5 flex justify-end">
          <Button
            onClick={handleCheckAnswer}
            disabled={submitting || answer.trim() === "" || !online}
            aria-disabled={!online}
            title={!online ? "Grading needs a connection" : undefined}
          >
            {submitting ? "Grading…" : LABELS.checkAnswer}
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
  question: Question;
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

// Completion screen: overall score plus a question-by-question expandable
// review. Uses the SAME Card + COLUMN max-width as the question view.
function QuizComplete({
  questions,
  answers,
  finalScore,
  onDone,
}: {
  conceptId: string;
  questions: Question[];
  answers: GradedAnswer[];
  finalScore: number;
  onDone: () => void;
}) {
  const pct = Math.round(finalScore * 100);
  const correct = answers.filter((a) => a.isCorrect).length;
  return (
    <Card>
      <h1 className="text-xl font-semibold text-text">Quiz complete</h1>
      <p className="mt-1 text-sm text-text-muted">
        You scored {pct}% ({correct} of {answers.length} correct).
      </p>

      <div className="mt-4 space-y-2">
        {answers.map((a) => {
          const q = questions.find((q) => q.id === a.questionId);
          return (
            <details
              key={a.questionId}
              className="rounded-lg border border-surface-border p-3"
            >
              <summary className="cursor-pointer text-sm font-medium text-text">
                <span
                  className={a.isCorrect ? "text-success" : "text-danger"}
                  aria-hidden="true"
                >
                  {a.isCorrect ? "✓" : "✗"}
                </span>{" "}
                {q ? <RichTextSummary prompt={q.prompt} /> : a.questionId}
              </summary>
              <div className="mt-2 space-y-2 text-sm">
                <div>
                  <span className="text-text-muted">Your answer: </span>
                  <span className="text-text">{a.userAnswer || "(blank)"}</span>
                </div>
                {a.errorPatternDetected && (
                  <div className="text-warning">
                    Pattern to watch: {a.errorPatternDetected}
                  </div>
                )}
                {q && (
                  <div>
                    <span className="text-text-muted">Explanation: </span>
                    <RichText content={q.explanation} className="prose" />
                  </div>
                )}
              </div>
            </details>
          );
        })}
      </div>

      <div className="mt-5 flex justify-end">
        <Button onClick={onDone}>{LABELS.continue}</Button>
      </div>
    </Card>
  );
}

// Inline prompt preview inside a <summary> (block elements aren't valid there,
// so render the prompt text compactly).
function RichTextSummary({ prompt }: { prompt: string }) {
  const oneLine = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  return <span className="text-text">{oneLine}</span>;
}
