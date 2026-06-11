import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, InlineError, OfflineNotice, Skeleton, useToast } from "../components/ui";
import { RichText } from "../components/RichText";
import { CurriculumDiagram } from "../components/CurriculumDiagram";
import { ipc } from "../lib/ipc";
import { useOnline } from "../lib/useOnline";
import type { PlacementResult, SubmittedAnswer } from "../lib/ipc";
import { LABELS } from "../lib/labels";
import { useCurriculumStore } from "../stores/useCurriculumStore";
import type { Question } from "../types/contract";

// The placement micro-quiz (milestone 4): 5 quiz-mode questions sampled across
// early-phase domains. CRITICAL (carry-forward #0f): every prompt renders through
// the SHARED KaTeX/DOMPurify renderer (<RichText>), NEVER literal "$...$" text.
// Grading is server-authoritative — we send only {questionId, answer}, never a
// correctness flag. On success the backend places the learner and marks
// onboarding complete; we then route to the dashboard.
//
// "Skip — let me choose where to start" seeds the foundational base, marks
// onboarding complete, and drops the learner onto the static curriculum diagram
// to tap any UNLOCKED concept (no full diagnostic required).

const COLUMN = "mx-auto w-full max-w-2xl";

type Phase = "loading" | "answering" | "placing" | "result" | "skipped";

export function PlacementPage() {
  const navigate = useNavigate();
  const { showError } = useToast();
  const online = useOnline();
  const setConcepts = useCurriculumStore((s) => s.setConcepts);

  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<PlacementResult | null>(null);

  // Running answers in a ref so the FINAL submit includes the last answer
  // (carry-forward bug 0e — a state array read in the submit handler is stale).
  const answersRef = useRef<SubmittedAnswer[]>([]);

  const loadQuiz = useCallback(() => {
    setPhase("loading");
    setLoadError(null);
    void ipc.generatePlacementQuiz().then((res) => {
      if (!res.ok) {
        setLoadError(res.error);
        showError(`Could not start the placement check: ${res.error}`, loadQuiz);
        return;
      }
      setQuestions(res.data);
      answersRef.current = [];
      setIndex(0);
      setAnswer("");
      setPhase("answering");
    });
  }, [showError]);

  useEffect(() => {
    loadQuiz();
  }, [loadQuiz]);

  const current = questions[index];
  const isLast = index === questions.length - 1;

  const handleNext = useCallback(() => {
    if (!current) return;
    answersRef.current = [...answersRef.current, { questionId: current.id, answer }];

    if (!isLast) {
      setIndex((i) => i + 1);
      setAnswer("");
      return;
    }

    setPhase("placing");
    void ipc.placeLearner(answersRef.current).then((res) => {
      if (!res.ok) {
        setPhase("answering");
        showError(`Could not place you: ${res.error}`, handleNext);
        return;
      }
      setResult(res.data);
      setPhase("result");
    });
  }, [current, answer, isLast, showError]);

  // Skip path: seed the base + complete onboarding, then load concept states and
  // show the diagram so the learner picks an unlocked concept to begin.
  const handleSkip = useCallback(() => {
    void ipc.skipPlacement().then((res) => {
      if (!res.ok) {
        showError(`Could not skip the placement check: ${res.error}`, handleSkip);
        return;
      }
      void ipc.getConceptStates().then((states) => {
        if (states.ok) setConcepts(states.data);
        setPhase("skipped");
      });
    });
  }, [showError, setConcepts]);

  const startLesson = useCallback(
    (conceptId: string) => navigate(`/lesson/${conceptId}`),
    [navigate],
  );

  if (phase === "loading" || phase === "placing") {
    return (
      <div className={`${COLUMN} px-4 py-8`}>
        <Card>
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
          <p className="mt-3 text-sm text-text-muted" aria-live="polite">
            {phase === "placing" ? "Placing you in the curriculum…" : "Building your placement check…"}
          </p>
        </Card>
      </div>
    );
  }

  if (loadError && questions.length === 0) {
    return (
      <div className={`${COLUMN} px-4 py-8`}>
        <Card>
          <InlineError message={loadError} onRetry={loadQuiz} />
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={handleSkip}>
              Skip — let me choose where to start
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (phase === "result" && result) {
    return (
      <div className={`${COLUMN} px-4 py-8`}>
        <Card>
          <h1 className="text-xl font-semibold text-text">You're all set</h1>
          <p className="mt-1 text-sm text-text-muted">
            You answered {result.correctCount} of {result.total} correctly. We'll start
            you at <span className="font-medium text-text">{result.title}</span> in{" "}
            {result.domain}.
          </p>
          <div className="mt-5 flex justify-end">
            <Button onClick={() => navigate("/dashboard")}>
              {LABELS.continue} to your dashboard
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (phase === "skipped") {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <Card>
          <h1 className="text-xl font-semibold text-text">Choose where to start</h1>
          <p className="mt-1 text-sm text-text-muted">
            Tap any unlocked concept (highlighted) to begin, or head to your
            dashboard to browse the full concept list.
          </p>
          <CurriculumDiagram className="mt-4" onSelectConcept={startLesson} />
          <div className="mt-5 flex justify-end">
            <Button variant="ghost" onClick={() => navigate("/dashboard")}>
              {LABELS.continue} to your dashboard
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (!current) return null;

  return (
    <div className={`${COLUMN} px-4 py-8`}>
      <Card>
        <div className="mb-3 flex items-center justify-between text-sm text-text-muted">
          <span>
            Placement check — question {index + 1} of {questions.length}
          </span>
          <button
            type="button"
            onClick={handleSkip}
            className="rounded text-sm text-text-muted underline hover:text-text"
          >
            Skip — let me choose where to start
          </button>
        </div>

        <RichText content={current.prompt} className="prose mb-4" />

        <PlacementInput question={current} value={answer} onChange={setAnswer} />

        {!online && (
          <OfflineNotice
            className="mt-4"
            detail="You're offline. The placement check needs a connection. You can skip and choose where to start, then begin once you're back online."
          />
        )}

        <div className="mt-5 flex justify-end">
          <Button
            onClick={handleNext}
            disabled={answer.trim() === "" || !online}
            aria-disabled={!online}
            title={!online ? "The placement check needs a connection" : undefined}
          >
            {isLast ? "Finish placement" : "Next"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// The input affordance per question type. Mirrors QuizPage's input but local to
// placement so the two screens stay independent.
function PlacementInput({
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
              name={`pq-${question.id}`}
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
    const inputId = `placement-answer-${question.id}`;
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

  const textareaId = `placement-answer-${question.id}`;
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
