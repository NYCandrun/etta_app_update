import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { ToastProvider } from "../components/ui";
import { OnboardingGate } from "../components/OnboardingGate";
import { useOnboardingStore } from "../stores/useOnboardingStore";
import { useCurriculumStore } from "../stores/useCurriculumStore";
import type { WireQuestion } from "../types/contract";

// TESTS REQUIRED (milestone 4): the placement micro-quiz must render a LaTeX
// prompt through the SHARED KaTeX renderer — NOT as the literal string
// "$3x - 7 = 14$" (v1's Diagnostic.tsx showed raw LaTeX; carry-forward #0f).
//
// WP3 additions covered here:
//   C1  — completing placement marks the frontend onboarding flag DONE, so
//         navigating onward is NOT bounced back to /onboarding (the old bug:
//         the gate's cached done:false redirected forever until a relaunch).
//   H4  — a failed quiz load reaches a REAL error card (Retry + the skip
//         escape hatch), instead of an eternal skeleton.
//   Skip — a getConceptStates failure on the skip path surfaces with Retry,
//         never a silently empty diagram.
//
// Questions are the REDACTED wire shape (H10): no blanks, no answer key.

const QUESTIONS: WireQuestion[] = [
  {
    id: "q1",
    type: "fill_in_blank",
    prompt: "Solve $3x - 7 = 14$ for $x$.",
    isTransfer: false,
  },
];

const PLACEMENT_RESULT = {
  conceptId: "alg_007",
  domain: "algebra",
  title: "Linear equations",
  correctCount: 1,
  total: 5,
};

const boundary = vi.hoisted(() => ({
  generatePlacementQuiz: vi.fn(),
  placeLearner: vi.fn(),
  skipPlacement: vi.fn(),
  getConceptStates: vi.fn(),
  getOnboardingComplete: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => {
  // Keep the REAL pure helpers (isApiKeyError, formatIpcError, …) so the
  // marker-stripping and detection behavior under test is the actual code.
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    ipc: {
      generatePlacementQuiz: boundary.generatePlacementQuiz,
      placeLearner: boundary.placeLearner,
      skipPlacement: boundary.skipPlacement,
      getConceptStates: boundary.getConceptStates,
      getOnboardingComplete: boundary.getOnboardingComplete,
    },
  };
});

import { PlacementPage } from "./PlacementPage";

beforeEach(() => {
  boundary.generatePlacementQuiz.mockReset();
  boundary.placeLearner.mockReset();
  boundary.skipPlacement.mockReset();
  boundary.getConceptStates.mockReset();
  boundary.getOnboardingComplete.mockReset();
  boundary.generatePlacementQuiz.mockImplementation(async () => ({
    ok: true,
    data: QUESTIONS,
  }));
  boundary.placeLearner.mockImplementation(async () => ({
    ok: true,
    data: PLACEMENT_RESULT,
  }));
  boundary.skipPlacement.mockImplementation(async () => ({ ok: true, data: null }));
  boundary.getConceptStates.mockImplementation(async () => ({ ok: true, data: [] }));
  boundary.getOnboardingComplete.mockImplementation(async () => ({
    ok: true,
    data: false,
  }));
  // Module-singleton stores: reset between tests.
  useOnboardingStore.setState({ status: "unknown", error: null });
  useCurriculumStore.setState({ concepts: {} });
});

function renderPlacement() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/placement"]}>
        <Routes>
          <Route path="/placement" element={<PlacementPage />} />
          <Route path="/dashboard" element={<div>dashboard-page</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe("PlacementPage math rendering (carry-forward #0f)", () => {
  it("renders a LaTeX prompt via KaTeX, never as literal $...$ text", async () => {
    const { container } = renderPlacement();

    // The prose prompt is rendered; the literal LaTeX delimiters must NOT appear.
    await waitFor(() =>
      expect(screen.getByText(/Solve/)).toBeInTheDocument(),
    );
    expect(container.textContent).not.toContain("$3x - 7 = 14$");
    expect(container.textContent).not.toContain("$x$");

    // KaTeX emits MathML (<math>) and a .katex wrapper — proof it rendered.
    expect(container.querySelector("math")).not.toBeNull();
    expect(container.querySelector(".katex")).not.toBeNull();
  });
});

describe("Placement completion unblocks the gate (C1)", () => {
  // The FULL first-run flow behind the real OnboardingGate: complete the
  // placement, follow the result CTA, and assert the gate does NOT bounce the
  // freshly-placed learner back to /onboarding.
  function renderGatedFlow() {
    return render(
      <ToastProvider>
        <MemoryRouter initialEntries={["/placement"]}>
          <OnboardingGate>
            <Routes>
              <Route path="/placement" element={<PlacementPage />} />
              <Route path="/onboarding" element={<div>onboarding-page</div>} />
              <Route path="/dashboard" element={<div>dashboard-page</div>} />
              <Route path="/lesson/:conceptId" element={<div>lesson-page</div>} />
            </Routes>
          </OnboardingGate>
        </MemoryRouter>
      </ToastProvider>,
    );
  }

  it("place_learner success → 'Start {title}' navigates WITHOUT bouncing to /onboarding", async () => {
    renderGatedFlow();

    // Backend still says "not onboarded" — the gate exempts /placement.
    await screen.findByText(/Solve/);
    fireEvent.change(screen.getByLabelText("Your answer"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: /finish placement/i }));

    // Result screen: primary CTA starts the placed concept directly.
    const start = await screen.findByRole("button", {
      name: /start linear equations/i,
    });
    expect(
      screen.getByRole("button", { name: /go to dashboard/i }),
    ).toBeInTheDocument();

    fireEvent.click(start);
    // C1 crux: /lesson/:id is a GATED route; the flag store was marked done,
    // so the learner lands there — never on /onboarding.
    expect(await screen.findByText("lesson-page")).toBeInTheDocument();
    expect(screen.queryByText("onboarding-page")).not.toBeInTheDocument();
    // The flag is terminal — no re-fetch happened after the initial hydrate.
    expect(boundary.getOnboardingComplete).toHaveBeenCalledTimes(1);
  });

  it("the skip path ALSO marks onboarding complete and reaches the dashboard", async () => {
    renderGatedFlow();
    await screen.findByText(/Solve/);

    fireEvent.click(
      screen.getByRole("button", { name: /skip — let me choose where to start/i }),
    );
    await screen.findByText(/Choose where to start/);

    fireEvent.click(screen.getByRole("button", { name: /continue to your dashboard/i }));
    expect(await screen.findByText("dashboard-page")).toBeInTheDocument();
    expect(screen.queryByText("onboarding-page")).not.toBeInTheDocument();
  });
});

describe("PlacementPage load failure (H4)", () => {
  it("reaches a real error card with Retry and the skip escape hatch", async () => {
    boundary.generatePlacementQuiz
      .mockImplementationOnce(async () => ({ ok: false, error: "no api key" }))
      .mockImplementationOnce(async () => ({ ok: true, data: QUESTIONS }));

    renderPlacement();

    // The error card is reachable (H4: no skeleton shadowing it) and offers
    // BOTH recovery paths: retry and skip.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no api key");
    expect(
      screen.getByRole("button", { name: /skip — let me choose where to start/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/Solve/)).toBeInTheDocument();
    expect(boundary.generatePlacementQuiz).toHaveBeenCalledTimes(2);
  });
});

// T1 (duplicate-append brick on the FIRST-RUN path): a failed place_learner
// re-enables 'Finish placement'; re-clicking it must resubmit each question
// exactly once (replace-on-re-answer), never append a duplicate the backend's
// exact-permutation gate rejects forever.
describe("PlacementPage failed submit + Finish re-click (idempotent answers)", () => {
  it("re-clicking 'Finish placement' after a failed placement submits unique answers and succeeds", async () => {
    boundary.placeLearner
      .mockImplementationOnce(async () => ({ ok: false, error: "network blip" }))
      .mockImplementation(async () => ({ ok: true, data: PLACEMENT_RESULT }));

    renderPlacement();
    await screen.findByText(/Solve/);
    fireEvent.change(screen.getByLabelText("Your answer"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: /finish placement/i }));
    await waitFor(() => expect(boundary.placeLearner).toHaveBeenCalledTimes(1));

    // Failure path: back on the question with the button visible. Click the
    // on-page Finish button again — NOT the toast's Retry.
    const finish = await screen.findByRole("button", { name: /finish placement/i });
    fireEvent.click(finish);

    await waitFor(() => expect(boundary.placeLearner).toHaveBeenCalledTimes(2));
    const resubmitted = boundary.placeLearner.mock.calls[1]?.[0] as Array<{
      questionId: string;
    }>;
    expect(resubmitted).toHaveLength(QUESTIONS.length);
    expect(new Set(resubmitted.map((a) => a.questionId)).size).toBe(
      QUESTIONS.length,
    );
    // The retried submission completes placement.
    expect(await screen.findByText(/You're all set/)).toBeInTheDocument();
  });
});

// T7: a rejected API key during placement must NOT point at Settings (gated
// away pre-completion) — the hint deep-links the onboarding key step.
describe("PlacementPage invalid API key path", () => {
  function OnboardingProbe() {
    const location = useLocation();
    return <div>onboarding-step:{new URLSearchParams(location.search).get("step")}</div>;
  }

  it("links 'fix your API key' back to the onboarding key step and hides the raw marker", async () => {
    boundary.generatePlacementQuiz.mockImplementationOnce(async () => ({
      ok: false,
      error: "EttaError:api_key: the API key was rejected — update it in Settings",
    }));

    render(
      <ToastProvider>
        <MemoryRouter initialEntries={["/placement"]}>
          <Routes>
            <Route path="/placement" element={<PlacementPage />} />
            <Route path="/onboarding" element={<OnboardingProbe />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    // The machine marker never reaches the screen…
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("the API key was rejected");
    expect(alert.textContent).not.toContain("EttaError:");

    // …and the pre-completion hint links to the ONBOARDING key step.
    const link = await screen.findByRole("link", { name: /fix your api key/i });
    fireEvent.click(link);
    expect(await screen.findByText("onboarding-step:key")).toBeInTheDocument();
  });
});

// T10: placement is a one-shot flow — re-entering it after onboarding is done
// (Back from the first lesson) must redirect home, never regenerate.
describe("PlacementPage post-completion re-entry", () => {
  it("redirects to /dashboard without regenerating when onboarding is already done", async () => {
    useOnboardingStore.setState({ status: "done", error: null });

    renderPlacement();

    expect(await screen.findByText("dashboard-page")).toBeInTheDocument();
    expect(boundary.generatePlacementQuiz).not.toHaveBeenCalled();
  });
});

// T12: StrictMode double-mounts effects in dev — generation must fire once.
describe("PlacementPage StrictMode mount", () => {
  it("fires exactly one placement generation under StrictMode double-mount", async () => {
    render(
      <StrictMode>
        <ToastProvider>
          <MemoryRouter initialEntries={["/placement"]}>
            <Routes>
              <Route path="/placement" element={<PlacementPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </StrictMode>,
    );
    await screen.findByText(/Solve/);
    expect(boundary.generatePlacementQuiz).toHaveBeenCalledTimes(1);
  });
});

// Item 4 (verified trace): place_learner and skip_placement are mutually
// exclusive completion paths behind ONE in-flight ref — a stale toast Retry
// (which bypasses any disabled button) must no-op while the other path is in
// flight, so the learner can never be both diagnostically placed AND
// base-seeded with last-response-wins deciding the final screen.
describe("PlacementPage completion-path re-entrancy (place XOR skip)", () => {
  it("a stale skip Retry no-ops while a placement submit is in flight", async () => {
    boundary.skipPlacement.mockImplementationOnce(async () => ({
      ok: false,
      error: "db locked",
    }));
    let settlePlace: (v: unknown) => void = () => {};
    boundary.placeLearner.mockImplementation(
      () => new Promise((resolve) => (settlePlace = resolve)),
    );

    renderPlacement();
    await screen.findByText(/Solve/);

    // Skip fails → its toast Retry lingers over the answering view.
    fireEvent.click(
      screen.getByRole("button", { name: /skip — let me choose where to start/i }),
    );
    const skipRetry = await screen.findByRole("button", { name: /^retry$/i });

    // Start the placement submit (in flight, unsettled)…
    fireEvent.change(screen.getByLabelText("Your answer"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: /finish placement/i }));
    await waitFor(() => expect(boundary.placeLearner).toHaveBeenCalledTimes(1));

    // …then the stale skip Retry: silent no-op (place holds the ref).
    fireEvent.click(skipRetry);
    expect(boundary.skipPlacement).toHaveBeenCalledTimes(1);

    // Only the winning call settles state: the RESULT screen, never both.
    settlePlace({ ok: true, data: PLACEMENT_RESULT });
    expect(await screen.findByText(/You're all set/)).toBeInTheDocument();
    expect(screen.queryByText(/Choose where to start/)).not.toBeInTheDocument();
    expect(boundary.skipPlacement).toHaveBeenCalledTimes(1);
  });

  it("a stale place Retry no-ops while skip is in flight, and skip alone wins the screen", async () => {
    boundary.placeLearner.mockImplementationOnce(async () => ({
      ok: false,
      error: "network blip",
    }));
    let settleSkip: (v: unknown) => void = () => {};
    boundary.skipPlacement.mockImplementation(
      () => new Promise((resolve) => (settleSkip = resolve)),
    );

    renderPlacement();
    await screen.findByText(/Solve/);
    fireEvent.change(screen.getByLabelText("Your answer"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: /finish placement/i }));

    // Place failed → back on the answering view with a live toast Retry.
    const placeRetry = await screen.findByRole("button", { name: /^retry$/i });

    // Start skip (in flight, unsettled) — the OTHER path's affordance
    // (Finish placement) visibly disables while skip holds the ref.
    fireEvent.click(
      screen.getByRole("button", { name: /skip — let me choose where to start/i }),
    );
    await waitFor(() => expect(boundary.skipPlacement).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("button", { name: /finish placement/i }),
    ).toBeDisabled();

    // The stale place Retry must no-op (skip holds the ref).
    fireEvent.click(placeRetry);
    expect(boundary.placeLearner).toHaveBeenCalledTimes(1);

    // Skip wins: the skipped screen settles, never the placement result.
    settleSkip({ ok: true, data: null });
    expect(await screen.findByText(/Choose where to start/)).toBeInTheDocument();
    expect(screen.queryByText(/You're all set/)).not.toBeInTheDocument();
    expect(boundary.placeLearner).toHaveBeenCalledTimes(1);
  });

  it("a lingering place Retry no-ops while a second placement submit is already in flight", async () => {
    let settlePlace: (v: unknown) => void = () => {};
    boundary.placeLearner
      .mockImplementationOnce(async () => ({ ok: false, error: "network blip" }))
      .mockImplementation(() => new Promise((resolve) => (settlePlace = resolve)));

    renderPlacement();
    await screen.findByText(/Solve/);
    fireEvent.change(screen.getByLabelText("Your answer"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: /finish placement/i }));
    const placeRetry = await screen.findByRole("button", { name: /^retry$/i });

    // Second submit via the on-page button (in flight, unsettled)…
    fireEvent.click(screen.getByRole("button", { name: /finish placement/i }));
    await waitFor(() => expect(boundary.placeLearner).toHaveBeenCalledTimes(2));

    // …then the lingering toast Retry: never a third concurrent place call
    // (double-paid grading, double-written placement seeding).
    fireEvent.click(placeRetry);
    expect(boundary.placeLearner).toHaveBeenCalledTimes(2);

    settlePlace({ ok: true, data: PLACEMENT_RESULT });
    expect(await screen.findByText(/You're all set/)).toBeInTheDocument();
    expect(boundary.placeLearner).toHaveBeenCalledTimes(2);
  });

  it("double-clicking Skip fires exactly one skipPlacement call", async () => {
    let settleSkip: (v: unknown) => void = () => {};
    boundary.skipPlacement.mockImplementation(
      () => new Promise((resolve) => (settleSkip = resolve)),
    );

    renderPlacement();
    await screen.findByText(/Solve/);

    const skip = screen.getByRole("button", {
      name: /skip — let me choose where to start/i,
    });
    fireEvent.click(skip);
    fireEvent.click(skip);
    expect(boundary.skipPlacement).toHaveBeenCalledTimes(1);

    settleSkip({ ok: true, data: null });
    expect(await screen.findByText(/Choose where to start/)).toBeInTheDocument();
    // One settle → one concept-state load, one completion.
    expect(boundary.getConceptStates).toHaveBeenCalledTimes(1);
    expect(boundary.skipPlacement).toHaveBeenCalledTimes(1);
  });
});

describe("PlacementPage skip path surfaces concept-state failures", () => {
  it("shows InlineError + Retry instead of a silently empty diagram", async () => {
    boundary.getConceptStates
      .mockImplementationOnce(async () => ({ ok: false, error: "db locked" }))
      .mockImplementationOnce(async () => ({ ok: true, data: [] }));

    renderPlacement();
    await screen.findByText(/Solve/);
    fireEvent.click(
      screen.getByRole("button", { name: /skip — let me choose where to start/i }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("db locked");

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() =>
      expect(boundary.getConceptStates).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
