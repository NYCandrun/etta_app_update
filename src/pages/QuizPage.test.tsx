import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";
import { ToastProvider } from "../components/ui";
import { AppLayout } from "../components/AppLayout";
import { useCurriculumStore } from "../stores/useCurriculumStore";
import { useLeaveGuardStore } from "../stores/useLeaveGuardStore";
import { useDailyProgressStore } from "../stores/useDailyProgressStore";
import type { AnswerSubmission, Concept, WireQuestion } from "../types/contract";

// Bug 0e (release-blocking): the final quiz submission must include the LAST
// answer. v1 read the score from a closure captured before the last state
// update, so an N-question quiz graded only N−1 answers. This test answers all
// N questions and asserts the payload handed to the merged server-side
// grade+record command counts N (with per-answer latency folded in).
//
// WP3 additions covered here: the advance button reads "Next" / "Finish quiz"
// (never a lying "Check Answer"), a real error phase with Retry + Back (H5),
// the staged grading label when written answers are present, the "Next up"
// CTA from a fresh build_session, and the sidebar leave guard.
//
// Questions are the REDACTED wire shape (H10): no blanks/isCorrect/rubric —
// the frontend never sees the answer key.

const QUESTIONS: WireQuestion[] = [
  { id: "q1", type: "fill_in_blank", prompt: "1+1=?", isTransfer: false },
  { id: "q2", type: "fill_in_blank", prompt: "2+2=?", isTransfer: false },
  { id: "q3", type: "fill_in_blank", prompt: "3+3=?", isTransfer: false },
];

const generateQuiz = vi.fn();
const gradeAndRecordQuiz = vi.fn();
const retryPersist = vi.fn();
const buildSession = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => {
  // Keep the REAL pure helpers (isApiKeyError, formatIpcError, …) so the
  // marker-stripping and detection behavior under test is the actual code.
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    ipc: {
      generateQuiz: (...args: unknown[]) => generateQuiz(...args),
      gradeAndRecordQuiz: (...args: unknown[]) => gradeAndRecordQuiz(...args),
      retryPersist: (...args: unknown[]) => retryPersist(...args),
      buildSession: (...args: unknown[]) => buildSession(...args),
      addStudyMinutes: vi.fn(async () => ({ ok: true, data: null })),
      getDailyProgress: vi.fn(async () => ({
        ok: true,
        data: { minutesToday: 0, goalMinutes: 30 },
      })),
    },
  };
});

const setGamification = vi.fn();
vi.mock("../stores/useGamificationStore", () => ({
  useGamificationStore: (sel: (s: unknown) => unknown) =>
    sel({ state: null, setState: setGamification }),
}));

import { QuizPage } from "./QuizPage";

const GAMIFICATION = {
  xp: 20,
  level: { level: 1, title: "Learner", xpIntoLevel: 20, xpForNextLevel: 21 },
  streak: {
    currentStreak: 1,
    longestStreak: 1,
    freezesAvailable: 0,
    lastActiveDate: "2026-06-11",
  },
  recentXpEvents: [],
  badges: [],
};

const EMPTY_SESSION = {
  conceptsNew: [],
  conceptsReview: [],
  interleavedSet: [],
  estimatedMinutes: 0,
};

function conceptFixture(id: string, title: string): Concept {
  return {
    id,
    domain: "algebra",
    module: "alg_m01",
    title,
    prerequisites: [],
    learningObjectives: [],
    difficultyTier: 1,
    errorPatterns: [],
    masteryScore: 0,
    effectiveMastery: 0,
    easeFactor: 2.5,
    intervalDays: 0,
    nextReview: null,
    lastAttemptAt: null,
    state: "unlocked",
  };
}

function outcomeFor(answers: AnswerSubmission[], recorded: boolean) {
  return {
    perQuestion: answers.map((a) => ({
      questionId: a.questionId,
      userAnswer: a.answer,
      isCorrect: true,
      score: 1,
      errorPatternDetected: null,
      correctAnswer: "42",
      feedback: "Nice.",
    })),
    finalScore: 1,
    allCorrect: true,
    recorded,
    retryToken: recorded ? null : "tok-1",
    gamification: recorded ? GAMIFICATION : null,
  };
}

beforeEach(() => {
  generateQuiz.mockReset();
  gradeAndRecordQuiz.mockReset();
  retryPersist.mockReset();
  buildSession.mockReset();
  setGamification.mockReset();
  generateQuiz.mockImplementation(async () => ({
    ok: true,
    data: { quizId: "row-7", questions: QUESTIONS },
  }));
  gradeAndRecordQuiz.mockImplementation(
    async (_conceptId: string, _quizId: string, answers: AnswerSubmission[]) => ({
      ok: true,
      data: outcomeFor(answers, true),
    }),
  );
  buildSession.mockImplementation(async () => ({ ok: true, data: EMPTY_SESSION }));
  // Zustand stores are module singletons — reset between tests.
  useCurriculumStore.setState({ concepts: {} });
  useLeaveGuardStore.setState({ guard: null });
  useDailyProgressStore.setState({
    progress: null,
    inFlight: null,
    errorNotified: false,
  });
});

function renderQuiz() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/quiz/alg_001"]}>
        <Routes>
          <Route path="/quiz/:conceptId" element={<QuizPage />} />
          <Route path="/dashboard" element={<div>dashboard-page</div>} />
          <Route path="/lesson/:conceptId" element={<div>lesson-page</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

// Advance through all questions: "Next" on q1/q2, "Finish quiz" on the last.
async function answerAll() {
  await screen.findByText("1+1=?");
  const answers = ["2", "4", "6"];
  for (let i = 0; i < answers.length; i++) {
    const input = await screen.findByLabelText("Your answer");
    fireEvent.change(input, { target: { value: answers[i] } });
    const isLast = i === answers.length - 1;
    fireEvent.click(
      screen.getByRole("button", { name: isLast ? /finish quiz/i : /^next$/i }),
    );
  }
}

describe("QuizPage final score (bug 0e)", () => {
  it("submits all N answers, including the last one, with latency folded in", async () => {
    renderQuiz();
    await answerAll();

    await waitFor(() => expect(gradeAndRecordQuiz).toHaveBeenCalledTimes(1));
    // The quiz-instance nonce from generateQuiz is passed through, so the
    // backend grades exactly the served quiz.
    expect(gradeAndRecordQuiz.mock.calls[0]?.[1]).toBe("row-7");
    const submitted = gradeAndRecordQuiz.mock.calls[0]?.[2] as AnswerSubmission[];
    // The crux of bug 0e: all 3 answers reach the merged command, not 2.
    expect(submitted).toHaveLength(QUESTIONS.length);
    expect(submitted[QUESTIONS.length - 1]).toMatchObject({
      questionId: "q3",
      answer: "6",
    });
    // Latency is folded per-answer (no separately-indexed array).
    for (const a of submitted) {
      expect(typeof a.latencyMs).toBe("number");
    }
    // Exactly one answer per question — no duplicates.
    expect(new Set(submitted.map((a) => a.questionId)).size).toBe(
      QUESTIONS.length,
    );

    // Recorded outcome syncs the gamification store from the merged response.
    await waitFor(() => expect(setGamification).toHaveBeenCalledTimes(1));
  });
});

describe("QuizPage persist failure (recorded:false)", () => {
  it("shows the score with exactly ONE save affordance — the banner, never a toast Retry", async () => {
    gradeAndRecordQuiz.mockImplementation(
      async (_conceptId: string, _quizId: string, answers: AnswerSubmission[]) => ({
        ok: true,
        data: outcomeFor(answers, false),
      }),
    );
    retryPersist.mockImplementation(async () => ({
      ok: true,
      data: { ...outcomeFor([], true), perQuestion: [] },
    }));

    renderQuiz();
    await answerAll();

    // The score renders even though persisting failed (show-score-anyway).
    await screen.findByText(/Quiz complete/);
    expect(setGamification).not.toHaveBeenCalled();
    // Unrecorded quizzes never fetch a "Next up" session.
    expect(buildSession).not.toHaveBeenCalled();

    // The saved-failed toast is INFORMATIONAL — no Retry action. The banner
    // is the single source of truth for saving, so no persist closure can
    // race the one-shot token or outlive this quiz instance in a toast.
    expect(
      await screen.findByText(/Could not save your results/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^retry$/i }),
    ).not.toBeInTheDocument();

    // The banner's Save re-persists via retryPersist(token) without re-grading.
    fireEvent.click(screen.getByRole("button", { name: /save results/i }));
    await waitFor(() => expect(retryPersist).toHaveBeenCalledWith("tok-1"));
    expect(gradeAndRecordQuiz).toHaveBeenCalledTimes(1);
    // A successful retry syncs gamification from the server-held result.
    await waitFor(() => expect(setGamification).toHaveBeenCalledTimes(1));
    // …and NOW the quiz counts as recorded, so the Next-up lookup fires.
    await waitFor(() => expect(buildSession).toHaveBeenCalledTimes(1));
  });
});

// Item 1 (verified trace): the toast Retry closure bypasses the disabled
// Finish button, so submit() itself must be single-flight via an in-flight
// ref — a concurrent second entry is a silent no-op.
describe("QuizPage submit re-entrancy", () => {
  it("keeps exactly one gradeAndRecordQuiz in flight when Finish and toast Retry race", async () => {
    let settle: (v: unknown) => void = () => {};
    gradeAndRecordQuiz
      .mockImplementationOnce(async () => ({ ok: false, error: "model overloaded" }))
      .mockImplementation(() => new Promise((resolve) => (settle = resolve)));

    renderQuiz();
    await answerAll();
    await waitFor(() => expect(gradeAndRecordQuiz).toHaveBeenCalledTimes(1));

    // The failure re-enabled Finish AND left a live toast Retry — the two
    // submit entry points. Grab the toast Retry, then fire Finish (submit #2
    // now in flight, unsettled)…
    const toastRetry = await screen.findByRole("button", { name: /^retry$/i });
    fireEvent.click(screen.getByRole("button", { name: /finish quiz/i }));
    await waitFor(() => expect(gradeAndRecordQuiz).toHaveBeenCalledTimes(2));

    // …then the toast Retry while #2 is in flight: silent no-op, never a
    // third concurrent grade (double model spend / double SM-2 apply).
    fireEvent.click(toastRetry);
    expect(gradeAndRecordQuiz).toHaveBeenCalledTimes(2);

    settle({
      ok: true,
      data: outcomeFor(
        [
          { questionId: "q1", answer: "2", latencyMs: 1 },
          { questionId: "q2", answer: "4", latencyMs: 1 },
          { questionId: "q3", answer: "6", latencyMs: 1 },
        ],
        true,
      ),
    });
    expect(await screen.findByText(/Quiz complete/)).toBeInTheDocument();
    // The guard cleared on settle and the whole flow graded exactly twice
    // (one failure + one success) — the race added nothing.
    expect(gradeAndRecordQuiz).toHaveBeenCalledTimes(2);
  });
});

// Item 2 (verified trace): the backend persist token is ONE-SHOT — a
// double-clicked Save would win with the first call and get "already saved"
// on the second, contradicting the just-cleared banner.
describe("QuizPage banner save re-entrancy", () => {
  it("double-clicking 'Save results' fires exactly one retryPersist and disables while saving", async () => {
    gradeAndRecordQuiz.mockImplementation(
      async (_conceptId: string, _quizId: string, answers: AnswerSubmission[]) => ({
        ok: true,
        data: outcomeFor(answers, false),
      }),
    );
    let settle: (v: unknown) => void = () => {};
    retryPersist.mockImplementation(() => new Promise((resolve) => (settle = resolve)));

    renderQuiz();
    await answerAll();
    await screen.findByText(/isn't saved yet/i);

    const save = screen.getByRole("button", { name: /save results/i });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(retryPersist).toHaveBeenCalledTimes(1);
    // The affordance visibly disables while the save is in flight.
    expect(save).toBeDisabled();

    settle({ ok: true, data: { ...outcomeFor([], true), perQuestion: [] } });
    // Success clears the banner and fires gamification + Next-up exactly once.
    await waitFor(() =>
      expect(screen.queryByText(/isn't saved yet/i)).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(setGamification).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(buildSession).toHaveBeenCalledTimes(1));
    expect(retryPersist).toHaveBeenCalledTimes(1);
  });
});

// Item 3 (verified trace, FE half — the backend half is defused server-side):
// a persist belonging to quiz instance A must never settle its outcome into a
// LATER instance. With the toast affordance gone, the remaining window is a
// persist still in flight when an in-place route change loads a new quiz —
// the settle handler must no-op for the stale instance.
describe("QuizPage stale persist across quiz instances", () => {
  function GoToQuizB() {
    const navigate = useNavigate();
    return (
      <button type="button" onClick={() => navigate("/quiz/alg_002")}>
        go-to-quiz-b
      </button>
    );
  }

  it("a persist settling after a NEW quiz instance loaded never syncs state into it", async () => {
    gradeAndRecordQuiz.mockImplementation(
      async (_conceptId: string, _quizId: string, answers: AnswerSubmission[]) => ({
        ok: true,
        data: outcomeFor(answers, false),
      }),
    );
    let settlePersist: (v: unknown) => void = () => {};
    retryPersist.mockImplementation(
      () => new Promise((resolve) => (settlePersist = resolve)),
    );
    generateQuiz
      .mockImplementationOnce(async () => ({
        ok: true,
        data: { quizId: "row-7", questions: QUESTIONS },
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        data: { quizId: "row-8", questions: QUESTIONS },
      }));

    render(
      <ToastProvider>
        <MemoryRouter initialEntries={["/quiz/alg_001"]}>
          <Routes>
            <Route
              path="/quiz/:conceptId"
              element={
                <>
                  <QuizPage />
                  <GoToQuizB />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
    await answerAll();
    await screen.findByText(/isn't saved yet/i);

    // Start the save for instance row-7 and leave it unsettled…
    fireEvent.click(screen.getByRole("button", { name: /save results/i }));
    expect(retryPersist).toHaveBeenCalledTimes(1);
    expect(retryPersist).toHaveBeenCalledWith("tok-1");

    // …then switch to a NEW quiz instance mid-flight (same component, route
    // param change — quizIdRef/retryTokenRef reset for row-8).
    fireEvent.click(screen.getByText("go-to-quiz-b"));
    expect(await screen.findByText(/Question 1 of 3/)).toBeInTheDocument();
    expect(generateQuiz).toHaveBeenCalledTimes(2);
    expect(generateQuiz).toHaveBeenLastCalledWith("alg_002");

    // The stale persist settles successfully AFTER instance B loaded: it must
    // not sync gamification, flip result state, or toast into the new attempt.
    await act(async () => {
      settlePersist({ ok: true, data: { ...outcomeFor([], true), perQuestion: [] } });
    });
    expect(setGamification).not.toHaveBeenCalled();
    expect(retryPersist).toHaveBeenCalledTimes(1);
    // Quiz B's attempt is untouched and still answerable.
    expect(screen.getByText("1+1=?")).toBeInTheDocument();
  });
});

// Critical M5 test (#11): offline mode must DISABLE the AI-dependent action,
// not merely show a banner. With navigator offline, the grade button is
// disabled and grading is never invoked even after typing a valid answer.
describe("QuizPage offline mode (#11)", () => {
  it("disables the advance action and never calls the grader while offline", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
    try {
      renderQuiz();
      await screen.findByText("1+1=?");

      const input = await screen.findByLabelText("Your answer");
      fireEvent.change(input, { target: { value: "2" } });

      const button = screen.getByRole("button", { name: /^next$/i });
      expect(button).toBeDisabled();

      // Clicking a disabled button must not reach the server-side grader.
      fireEvent.click(button);
      expect(gradeAndRecordQuiz).not.toHaveBeenCalled();
    } finally {
      // `onLine` normally lives on Navigator.prototype, so there is no own
      // descriptor to restore — DELETE the own override or every later test
      // in this file runs "offline".
      if (original) Object.defineProperty(navigator, "onLine", original);
      else delete (navigator as { onLine?: boolean }).onLine;
      window.dispatchEvent(new Event("online"));
    }
  });
});

describe("QuizPage load failure (H5)", () => {
  it("reaches a real error card with Retry that reloads, plus a Back action", async () => {
    generateQuiz
      .mockImplementationOnce(async () => ({ ok: false, error: "model exploded" }))
      .mockImplementationOnce(async () => ({
        ok: true,
        data: { quizId: "row-7", questions: QUESTIONS },
      }));

    renderQuiz();

    // The error card is REACHABLE (no skeleton shadowing it — H5) and offers
    // both Retry and Back (never a dead end).
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("model exploded");
    expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("1+1=?")).toBeInTheDocument();
    expect(generateQuiz).toHaveBeenCalledTimes(2);
  });

  it("treats an empty question list as an error, not a blank quiz (H21 guard)", async () => {
    generateQuiz.mockImplementationOnce(async () => ({
      ok: true,
      data: { quizId: "row-7", questions: [] },
    }));

    renderQuiz();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/came back empty/i);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("QuizPage staged grading label", () => {
  it("says 'Checking your written answers…' while grading a quiz with a free_response", async () => {
    generateQuiz.mockImplementation(async () => ({
      ok: true,
      data: {
        quizId: "row-7",
        questions: [
          { id: "q1", type: "free_response", prompt: "Explain 1+1.", isTransfer: false },
        ] as WireQuestion[],
      },
    }));
    let settle: (v: unknown) => void = () => {};
    gradeAndRecordQuiz.mockImplementation(
      () => new Promise((resolve) => (settle = resolve)),
    );

    renderQuiz();
    await screen.findByText("Explain 1+1.");
    fireEvent.change(await screen.findByLabelText("Your answer"), {
      target: { value: "Because arithmetic." },
    });
    fireEvent.click(screen.getByRole("button", { name: /finish quiz/i }));

    expect(
      await screen.findByRole("button", { name: /checking your written answers/i }),
    ).toBeInTheDocument();

    settle({ ok: true, data: outcomeFor([{ questionId: "q1", answer: "x", latencyMs: 1 }], true) });
    await screen.findByText(/Quiz complete/);
  });
});

describe("QuizComplete 'Next up' CTA", () => {
  it("offers the next session concept after a recorded quiz and navigates to its lesson", async () => {
    useCurriculumStore.setState({
      concepts: { alg_002: conceptFixture("alg_002", "Quadratic equations") },
    });
    buildSession.mockImplementation(async () => ({
      ok: true,
      data: { ...EMPTY_SESSION, interleavedSet: ["alg_001", "alg_002"] },
    }));

    renderQuiz();
    await answerAll();
    await screen.findByText(/Quiz complete/);

    // Prefers a concept OTHER than the one just quizzed.
    const cta = await screen.findByRole("button", {
      name: /next up: quadratic equations/i,
    });
    // "Back to dashboard" stays available as the secondary path.
    expect(
      screen.getByRole("button", { name: /back to dashboard/i }),
    ).toBeInTheDocument();

    fireEvent.click(cta);
    expect(await screen.findByText("lesson-page")).toBeInTheDocument();
  });

  it("review maps option ids to option text and states correctness in words", async () => {
    const mcq: WireQuestion[] = [
      {
        id: "q1",
        type: "multiple_choice",
        prompt: "Pick $x$.",
        options: [
          { id: "a", text: "Option Alpha" },
          { id: "b", text: "Option Beta" },
        ],
        isTransfer: false,
      },
    ];
    generateQuiz.mockImplementation(async () => ({
      ok: true,
      data: { quizId: "row-7", questions: mcq },
    }));
    gradeAndRecordQuiz.mockImplementation(async () => ({
      ok: true,
      data: {
        perQuestion: [
          {
            questionId: "q1",
            userAnswer: "b", // raw option ID on the wire
            isCorrect: false,
            score: 0,
            errorPatternDetected: null,
            correctAnswer: "Option Alpha",
            feedback: null,
          },
        ],
        finalScore: 0,
        allCorrect: false,
        recorded: true,
        retryToken: null,
        gamification: GAMIFICATION,
      },
    }));

    renderQuiz();
    await screen.findByText(/Pick/);
    fireEvent.click(screen.getByRole("radio", { name: /option beta/i }));
    fireEvent.click(screen.getByRole("button", { name: /finish quiz/i }));
    await screen.findByText(/Quiz complete/);

    // Correctness is words, not a colored glyph alone.
    expect(screen.getByText(/incorrect/i)).toBeInTheDocument();
    // The learner's answer shows the OPTION TEXT, never the raw id "b".
    expect(screen.getByText("Option Beta")).toBeInTheDocument();
    expect(screen.getByText("Option Alpha")).toBeInTheDocument();
  });
});

// T1 (duplicate-append brick): a failed grade leaves the learner on the last
// question with the 'Finish quiz' button visible. Clicking it AGAIN (not the
// toast retry) must resubmit each question exactly once — the old append-only
// ref accumulated a duplicate that the backend's exact-permutation gate
// rejected forever.
describe("QuizPage failed submit + Finish re-click (idempotent answers)", () => {
  it("re-clicking 'Finish quiz' after a failed grade submits exactly N unique answers and succeeds", async () => {
    gradeAndRecordQuiz
      .mockImplementationOnce(async () => ({ ok: false, error: "model overloaded" }))
      .mockImplementation(
        async (_conceptId: string, _quizId: string, answers: AnswerSubmission[]) => ({
          ok: true,
          data: outcomeFor(answers, true),
        }),
      );

    renderQuiz();
    await answerAll();
    await waitFor(() => expect(gradeAndRecordQuiz).toHaveBeenCalledTimes(1));

    // Failure path: still on the last question, button re-enabled. Click the
    // on-page Finish button again — NOT the toast's Retry.
    const finish = await screen.findByRole("button", { name: /finish quiz/i });
    fireEvent.click(finish);

    await waitFor(() => expect(gradeAndRecordQuiz).toHaveBeenCalledTimes(2));
    // The re-click submits the SAME quiz instance (nonce unchanged).
    expect(gradeAndRecordQuiz.mock.calls[1]?.[1]).toBe("row-7");
    const resubmitted = gradeAndRecordQuiz.mock.calls[1]?.[2] as AnswerSubmission[];
    // Exactly N answers with unique question ids — never a duplicate append.
    expect(resubmitted).toHaveLength(QUESTIONS.length);
    expect(new Set(resubmitted.map((a) => a.questionId)).size).toBe(
      QUESTIONS.length,
    );
    // And the retried submission completes the quiz.
    expect(await screen.findByText(/Quiz complete/)).toBeInTheDocument();
  });
});

// T2: recorded:false must not live only in a 6s toast — the completion screen
// carries a persistent banner with its own save action.
describe("QuizPage completion banner for an unsaved result", () => {
  it("shows a persistent 'not saved' banner whose Save action re-persists and then clears", async () => {
    gradeAndRecordQuiz.mockImplementation(
      async (_conceptId: string, _quizId: string, answers: AnswerSubmission[]) => ({
        ok: true,
        data: outcomeFor(answers, false),
      }),
    );
    retryPersist.mockImplementation(async () => ({
      ok: true,
      data: { ...outcomeFor([], true), perQuestion: [] },
    }));

    renderQuiz();
    await answerAll();
    await screen.findByText(/Quiz complete/);

    // The banner is inline on the completion screen (not the toast).
    expect(await screen.findByText(/isn't saved yet/i)).toBeInTheDocument();
    expect(buildSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /save results/i }));
    await waitFor(() => expect(retryPersist).toHaveBeenCalledWith("tok-1"));

    // Success: banner clears, gamification syncs, and the Next-up CTA fetch
    // (gated on recorded) now fires.
    await waitFor(() =>
      expect(screen.queryByText(/isn't saved yet/i)).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(setGamification).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(buildSession).toHaveBeenCalledTimes(1));
  });
});

// T12: StrictMode double-mounts effects in dev — generation must fire once.
describe("QuizPage StrictMode mount", () => {
  it("fires exactly one generation under StrictMode double-mount", async () => {
    render(
      <StrictMode>
        <ToastProvider>
          <MemoryRouter initialEntries={["/quiz/alg_001"]}>
            <Routes>
              <Route path="/quiz/:conceptId" element={<QuizPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </StrictMode>,
    );
    await screen.findByText("1+1=?");
    expect(generateQuiz).toHaveBeenCalledTimes(1);
  });
});

describe("QuizPage sidebar leave guard", () => {
  function renderWithLayout() {
    return render(
      <ToastProvider>
        <MemoryRouter initialEntries={["/quiz/alg_001"]}>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/quiz/:conceptId" element={<QuizPage />} />
              <Route path="/dashboard" element={<div>dashboard-page</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );
  }

  it("intercepts sidebar navigation mid-quiz and continues to the link on Leave", async () => {
    renderWithLayout();
    await screen.findByText("1+1=?");
    // Make progress so the guard arms.
    fireEvent.change(await screen.findByLabelText("Your answer"), {
      target: { value: "2" },
    });

    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));

    // Navigation was blocked; the inline confirm shows instead.
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.queryByText("dashboard-page")).not.toBeInTheDocument();

    // Confirming continues to the ORIGINAL destination.
    fireEvent.click(screen.getByRole("button", { name: /^leave$/i }));
    expect(await screen.findByText("dashboard-page")).toBeInTheDocument();
  });

  it("lets sidebar navigation through when the quiz has no progress", async () => {
    renderWithLayout();
    await screen.findByText("1+1=?");

    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    expect(await screen.findByText("dashboard-page")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
