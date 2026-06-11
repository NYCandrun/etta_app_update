import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ToastProvider } from "../components/ui";
import type { Concept } from "../types/contract";

// Bug 0g (release-blocking): a reinforcement lesson must carry the learner's
// ACTUAL recent mistakes into the assembled prompt. v1 captured an empty array
// in a stale closure at mount, so the mistakes never reached the AI. Here the
// concept has real errorPatterns; we assert they appear in the userInput passed
// to streamGenerate (the field the backend interpolates into <user_input>).

const CONCEPT: Concept = {
  id: "alg_001",
  domain: "algebra",
  module: "alg_m01",
  title: "Linear equations",
  prerequisites: [],
  learningObjectives: [],
  difficultyTier: 1,
  errorPatterns: ["sign_error_when_moving_terms", "divides_before_distributing"],
  masteryScore: 0.3,
  effectiveMastery: 0.3,
  easeFactor: 2.5,
  intervalDays: 1,
  nextReview: null,
  state: "in_progress",
};

const streamGenerate = vi.fn();

vi.mock("../lib/ipc", () => ({
  ipc: {
    getConceptStates: vi.fn(async () => ({ ok: true, data: [CONCEPT] })),
    awardLessonXp: vi.fn(async () => ({ ok: true, data: null })),
    addStudyMinutes: vi.fn(async () => ({ ok: true, data: null })),
  },
  streamGenerate: (...args: unknown[]) => streamGenerate(...args),
}));

vi.mock("../stores/useGamificationStore", () => ({
  useGamificationStore: (sel: (s: unknown) => unknown) =>
    sel({ setState: vi.fn() }),
}));

import { LessonPage } from "./LessonPage";

beforeEach(() => {
  streamGenerate.mockReset();
  streamGenerate.mockImplementation(async () => ({ ok: true, data: "lesson text" }));
});

function renderLesson() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/lesson/alg_001"]}>
        <Routes>
          <Route path="/lesson/:conceptId" element={<LessonPage />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe("LessonPage reinforcement context (bug 0g)", () => {
  it("passes the learner's current mistakes into the lesson prompt", async () => {
    renderLesson();

    await waitFor(() => expect(streamGenerate).toHaveBeenCalled());
    const arg = streamGenerate.mock.calls[0]?.[0] as {
      mode: string;
      userInput?: string;
    };
    expect(arg.mode).toBe("lesson");
    // The crux of 0g: the real error patterns reach the prompt, not an empty
    // array captured in a stale closure at mount.
    expect(arg.userInput).toContain("sign_error_when_moving_terms");
    expect(arg.userInput).toContain("divides_before_distributing");
  });
});
