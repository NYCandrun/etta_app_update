import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ToastProvider } from "../components/ui";
import type { Question } from "../types/contract";

// Bug 0e (release-blocking): the final quiz submission must include the LAST
// answer. v1 read the score from a closure captured before the last state
// update, so an N-question quiz graded only N−1 answers. This test answers all
// N questions and asserts the payload handed to the server grader counts N.

const QUESTIONS: Question[] = [
  {
    id: "q1",
    type: "fill_in_blank",
    prompt: "1+1=?",
    blanks: ["2"],
    explanation: "",
    difficulty: 1,
    isTransfer: false,
  },
  {
    id: "q2",
    type: "fill_in_blank",
    prompt: "2+2=?",
    blanks: ["4"],
    explanation: "",
    difficulty: 1,
    isTransfer: false,
  },
  {
    id: "q3",
    type: "fill_in_blank",
    prompt: "3+3=?",
    blanks: ["6"],
    explanation: "",
    difficulty: 1,
    isTransfer: false,
  },
];

const gradeQuiz = vi.fn();
const recordQuizResult = vi.fn();

vi.mock("../lib/ipc", () => ({
  ipc: {
    generateQuiz: vi.fn(async () => ({ ok: true, data: QUESTIONS })),
    gradeQuiz: (...args: unknown[]) => gradeQuiz(...args),
    recordQuizResult: (...args: unknown[]) => recordQuizResult(...args),
    addStudyMinutes: vi.fn(async () => ({ ok: true, data: null })),
  },
}));

vi.mock("../stores/useGamificationStore", () => ({
  useGamificationStore: (sel: (s: unknown) => unknown) =>
    sel({ setState: vi.fn() }),
}));

import { QuizPage } from "./QuizPage";

beforeEach(() => {
  gradeQuiz.mockReset();
  recordQuizResult.mockReset();
  gradeQuiz.mockImplementation(async (_conceptId: string, answers: unknown[]) => ({
    ok: true,
    data: {
      answers: (answers as { questionId: string; answer: string }[]).map((a) => ({
        questionId: a.questionId,
        userAnswer: a.answer,
        isCorrect: true,
        score: 1,
        errorPatternDetected: null,
      })),
      finalScore: 1,
    },
  }));
  recordQuizResult.mockImplementation(async () => ({
    ok: true,
    data: {
      gamification: {
        xp: 20,
        level: { level: 1, title: "Learner", xpIntoLevel: 20, xpForNextLevel: 21 },
        streak: { currentStreak: 1, longestStreak: 1, freezesAvailable: 0, lastActiveDate: "2026-06-11" },
        recentXpEvents: [],
        badges: [],
      },
      nextReview: "2026-06-17",
      intervalDays: 6,
      easeFactor: 2.5,
      masteryScore: 1,
    },
  }));
});

function renderQuiz() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/quiz/alg_001"]}>
        <Routes>
          <Route path="/quiz/:conceptId" element={<QuizPage />} />
          <Route path="/dashboard" element={<div>dashboard</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe("QuizPage final score (bug 0e)", () => {
  it("submits all N answers, including the last one", async () => {
    renderQuiz();

    // Wait for the first question to render.
    await screen.findByText("1+1=?");

    const answers = ["2", "4", "6"];
    for (let i = 0; i < answers.length; i++) {
      const input = await screen.findByLabelText("Your answer");
      fireEvent.change(input, { target: { value: answers[i] } });
      fireEvent.click(screen.getByRole("button", { name: /check answer/i }));
    }

    await waitFor(() => expect(gradeQuiz).toHaveBeenCalledTimes(1));
    const submitted = gradeQuiz.mock.calls[0]?.[1] as unknown[];
    // The crux of bug 0e: all 3 answers reach the grader, not 2.
    expect(submitted).toHaveLength(QUESTIONS.length);
    expect(submitted[QUESTIONS.length - 1]).toMatchObject({
      questionId: "q3",
      answer: "6",
    });

    // And the graded result is persisted with the same full count.
    await waitFor(() => expect(recordQuizResult).toHaveBeenCalledTimes(1));
    const persisted = recordQuizResult.mock.calls[0]?.[1] as unknown[];
    expect(persisted).toHaveLength(QUESTIONS.length);
  });
});

// Critical M5 test (#11): offline mode must DISABLE the AI-dependent action,
// not merely show a banner. With navigator offline, the grade button is
// disabled and grading is never invoked even after typing a valid answer.
describe("QuizPage offline mode (#11)", () => {
  it("disables the grade action and never calls the grader while offline", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
    try {
      renderQuiz();
      await screen.findByText("1+1=?");

      const input = await screen.findByLabelText("Your answer");
      fireEvent.change(input, { target: { value: "2" } });

      const button = screen.getByRole("button", { name: /check answer/i });
      expect(button).toBeDisabled();

      // Clicking a disabled button must not reach the server-side grader.
      fireEvent.click(button);
      expect(gradeQuiz).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(navigator, "onLine", original);
      window.dispatchEvent(new Event("online"));
    }
  });
});
