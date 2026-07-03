import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button, Card, InlineError, OfflineNotice, Skeleton, useToast } from "../components/ui";
import { RichText } from "../components/RichText";
import { CurriculumDiagram } from "../components/CurriculumDiagram";
import { ApiKeyHint } from "../components/ApiKeyHint";
import { formatIpcError, ipc } from "../lib/ipc";
import { useOnline } from "../lib/useOnline";
import { LABELS } from "../lib/labels";
import { useCurriculumStore } from "../stores/useCurriculumStore";
import { useOnboardingStore } from "../stores/useOnboardingStore";
import type {
  AnswerSubmission,
  PlacementResult,
  WireQuestion,
} from "../types/contract";

// The placement micro-quiz (milestone 4): 5 quiz-mode questions sampled across
// early-phase domains. CRITICAL (carry-forward #0f): every prompt renders through
// the SHARED KaTeX/DOMPurify renderer (<RichText>), NEVER literal "$...$" text.
// Grading is server-authoritative — we send only {questionId, answer}, never a
// correctness flag. On success the backend places the learner and marks
// onboarding complete server-side; we ALSO mark the frontend onboarding store
// complete (C1 — the gate's flag is terminal and never re-fetched, so both
// completion paths flip it here) and offer "Start {placed concept}" directly.
//
// "Skip — let me choose where to start" seeds the foundational base, marks
// onboarding complete, and drops the learner onto the static curriculum diagram
// to tap any UNLOCKED concept (no full diagnostic required).

const COLUMN = "mx-auto w-full max-w-2xl";

type Phase = "loading" | "error" | "answering" | "placing" | "result" | "skipped";

export function PlacementPage() {
  const navigate = useNavigate();
  const { showError } = useToast();
  const online = useOnline();
  const setConcepts = useCurriculumStore((s) => s.setConcepts);
  const markComplete = useOnboardingStore((s) => s.markComplete);

  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<WireQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<PlacementResult | null>(null);
  // Skip path: concept-state loading for the pick-your-start diagram. A load
  // failure is surfaced with retry — never a silently empty diagram.
  const [statesLoading, setStatesLoading] = useState(false);
  const [statesError, setStatesError] = useState<string | null>(null);

  // Running answers in a ref so the FINAL submit includes the last answer
  // (carry-forward bug 0e — a state array read in the submit handler is stale).
  // KEYED by questionId with replace-on-re-answer semantics: re-clicking
  // "Finish placement" after a failed place_learner call REPLACES the last
  // answer instead of appending a duplicate that the backend's
  // exact-permutation gate would reject forever (first-run dead end).
  // Placement latency is not tracked (no adaptive schedule rides on it).
  const answersRef = useRef(new Map<string, AnswerSubmission>());

  // Single-flight guard covering BOTH completion paths (verified race):
  // place_learner and skip_placement are mutually exclusive — checked-and-set
  // at function entry (a ref, because toast Retry closures bypass any
  // disabled button and phase state lands a render late), cleared on settle.
  // Whichever call starts is the ONLY one that can settle state, so a
  // placed-vs-skipped last-response-wins on setResult/markComplete/phase is
  // impossible by construction.
  const actionRef = useRef<"place" | "skip" | null>(null);
  // Mirror of the skip leg for affordance disabling: skip runs WITHOUT
  // leaving the answering/error view, so while it's in flight the other
  // path's buttons (Finish placement / Skip) need a visible disabled state.
  const [skipping, setSkipping] = useState(false);

  // Placement is a ONE-SHOT first-run flow: if onboarding was already complete
  // when this page mounted (e.g. Back from the first lesson re-entering
  // /placement, which the gate permanently exempts), redirect to the dashboard
  // instead of silently regenerating a fresh 5-call placement quiz. Captured
  // once at mount so completing placement ON this page (markComplete flips the
  // store to done) never redirects away from the result screen.
  const [redirectHome] = useState(
    () => useOnboardingStore.getState().status === "done",
  );

  // Whether this instance is still mounted: toasts outlive the page, so their
  // Retry actions must no-op after unmount (an abandoned placement submit
  // would otherwise place the learner and mark onboarding complete unseen).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadQuiz = useCallback(() => {
    setPhase("loading");
    setLoadError(null);
    void ipc.generatePlacementQuiz().then((res) => {
      if (!res.ok) {
        // Real error phase (H4): the card below carries Retry AND the skip
        // escape hatch, so a persistently failing setup never traps the
        // first-run learner on a skeleton.
        setLoadError(res.error);
        setPhase("error");
        return;
      }
      setQuestions(res.data);
      answersRef.current = new Map();
      setIndex(0);
      setAnswer("");
      setPhase("answering");
    });
  }, []);

  // StrictMode-safe init (dev double-mounts run effects twice): generation
  // fires exactly once per mounted instance; a real remount is a fresh ref and
  // generates again. Skipped entirely when this mount is just a redirect.
  const didInitRef = useRef(false);
  useEffect(() => {
    if (redirectHome || didInitRef.current) return;
    didInitRef.current = true;
    loadQuiz();
  }, [loadQuiz, redirectHome]);

  const current = questions[index];
  const isLast = index === questions.length - 1;

  // Latest phase for the toast Retry closures: toasts outlive renders (and
  // the page), so a closure must re-check the CURRENT phase at click time,
  // not the phase it captured when the toast was shown.
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  });

  // Submit the accumulated answers (exactly one per question — the array is
  // built from the keyed Map, so the on-page button and the toast retry both
  // submit each question exactly once; the backend rejects duplicates). Named
  // function expression so the retry action can re-arm itself; the toast
  // retry no-ops after unmount, while another completion call is in flight,
  // or after the flow moved past the answering view (a skip that already won
  // must not be raced by a stale place Retry).
  const submitPlacement = useCallback(
    function submit() {
      if (actionRef.current) return; // single-flight: place XOR skip
      actionRef.current = "place";
      setPhase("placing");
      void ipc.placeLearner(Array.from(answersRef.current.values())).then((res) => {
        actionRef.current = null;
        if (!res.ok) {
          setPhase("answering");
          showError(`Could not place you: ${formatIpcError(res.error)}`, () => {
            if (
              mountedRef.current &&
              !actionRef.current &&
              phaseRef.current === "answering"
            ) {
              submit();
            }
          });
          return;
        }
        // C1: unblock the gate NOW — done is terminal, no re-fetch, no bounce.
        markComplete();
        setResult(res.data);
        setPhase("result");
      });
    },
    [showError, markComplete],
  );

  // Record the current answer keyed by questionId (replace-on-re-answer, so a
  // failed final submit + re-click stays idempotent), then advance or submit.
  const handleNext = useCallback(() => {
    if (!current) return;
    answersRef.current.set(current.id, {
      questionId: current.id,
      answer,
      latencyMs: null,
    });

    if (!isLast) {
      setIndex((i) => i + 1);
      setAnswer("");
      return;
    }

    submitPlacement();
  }, [current, answer, isLast, submitPlacement]);

  // Load concept states for the skip diagram. Failure renders InlineError +
  // Retry in the skipped view (H4: no silent empty diagram).
  const loadSkipStates = useCallback(
    function loadStates() {
      setStatesLoading(true);
      setStatesError(null);
      void ipc.getConceptStates().then((states) => {
        setStatesLoading(false);
        if (!states.ok) {
          setStatesError(states.error);
          return;
        }
        setConcepts(states.data);
      });
    },
    [setConcepts],
  );

  // Skip path: seed the base + complete onboarding, then load concept states and
  // show the diagram so the learner picks an unlocked concept to begin.
  // Shares the single-flight ref with submitPlacement (mutually exclusive):
  // a double-click no-ops, and a skip can never start while a placement
  // submit is in flight (or vice versa). The Retry closure re-checks the ref
  // AND the phase at click time — skip is only offerable from the answering
  // and error views.
  const handleSkip = useCallback(
    function skip() {
      if (actionRef.current) return; // single-flight: place XOR skip
      actionRef.current = "skip";
      setSkipping(true);
      void ipc.skipPlacement().then((res) => {
        actionRef.current = null;
        setSkipping(false);
        if (!res.ok) {
          showError(`Could not skip the placement check: ${formatIpcError(res.error)}`, () => {
            if (
              mountedRef.current &&
              !actionRef.current &&
              (phaseRef.current === "answering" || phaseRef.current === "error")
            ) {
              skip();
            }
          });
          return;
        }
        // C1: skip ALSO completes onboarding — flip the terminal flag.
        markComplete();
        setPhase("skipped");
        loadSkipStates();
      });
    },
    [showError, markComplete, loadSkipStates],
  );

  const startLesson = useCallback(
    (conceptId: string) => navigate(`/lesson/${conceptId}`),
    [navigate],
  );

  // Post-completion re-entry (Back from the first lesson): placement is done,
  // one-shot, and must not regenerate — go home instead.
  if (redirectHome) {
    return <Navigate to="/dashboard" replace />;
  }

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

  if (phase === "error") {
    return (
      <div className={`${COLUMN} px-4 py-8`}>
        <Card>
          <OfflineNotice
            className="mb-3"
            detail="You're offline. The placement check needs a connection — reconnect and retry, or skip and choose where to start."
          />
          <InlineError
            message={`Could not start the placement check: ${
              loadError ? formatIpcError(loadError) : "unknown error"
            }`}
            onRetry={loadQuiz}
          />
          {/* A rejected key can't be fixed by retrying, and /settings is gated
              away pre-completion — the hint deep-links the ONBOARDING key step
              (its pre-completion variant) so this is never a dead loop. */}
          {loadError && <ApiKeyHint error={loadError} />}
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" onClick={handleSkip} disabled={skipping}>
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
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => navigate("/dashboard")}>
              Go to dashboard
            </Button>
            <Button onClick={() => navigate(`/lesson/${result.conceptId}`)}>
              Start {result.title}
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
          {statesLoading ? (
            <div className="mt-4 space-y-3" aria-busy="true">
              <Skeleton className="h-40 w-full" />
            </div>
          ) : statesError ? (
            <InlineError
              className="mt-4"
              message={`Could not load your concepts: ${formatIpcError(statesError)}`}
              onRetry={loadSkipStates}
            />
          ) : (
            <CurriculumDiagram className="mt-4" onSelectConcept={startLesson} />
          )}
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
            disabled={skipping}
            className="rounded text-sm text-text-muted underline hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            Skip — let me choose where to start
          </button>
        </div>

        <RichText content={current.prompt} className="prose mb-4" />

        <PlacementInput question={current} value={answer} onChange={setAnswer} />

        <OfflineNotice
          className="mt-4"
          detail="You're offline. The placement check needs a connection. You can skip and choose where to start, then begin once you're back online."
        />

        <div className="mt-5 flex justify-end">
          <Button
            onClick={handleNext}
            // `skipping`: starting the skip path disables the other
            // completion path's affordance (mutually exclusive — the shared
            // in-flight ref is the hard gate, this is the visible one).
            disabled={answer.trim() === "" || !online || skipping}
            aria-disabled={!online}
            title={!online ? "The placement check needs a connection" : undefined}
          >
            {isLast ? LABELS.finishPlacement : LABELS.next}
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
