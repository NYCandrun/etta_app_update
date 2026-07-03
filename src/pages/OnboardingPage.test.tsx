import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ToastProvider } from "../components/ui";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { AppSettings } from "../types/contract";

// T8: a failed getSettings hydrate must surface a PERSISTENT inline error
// with Retry — never strand the first-run learner on an aria-busy skeleton
// once the transient toast has dismissed.
// T7 (companion): ?step=key deep-links straight to the API-key step, so
// pre-completion error surfaces (placement) have a reachable fix-it path.

const boundary = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSetting: vi.fn(),
  setApiKey: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return { ...actual, ipc: boundary };
});

import { OnboardingPage } from "./OnboardingPage";

const SETTINGS: AppSettings = {
  dailyGoalMinutes: 30,
  theme: "system",
  baseModel: "claude-sonnet-4-6",
  reasoningModel: "claude-opus-4-8",
  newConceptsPerSession: 3,
  notificationsEnabled: false,
  apiKeyPresent: false,
};

beforeEach(() => {
  boundary.getSettings.mockReset();
  boundary.setSetting.mockReset();
  boundary.setApiKey.mockReset();
  boundary.getSettings.mockImplementation(async () => ({ ok: true, data: SETTINGS }));
  boundary.setSetting.mockImplementation(async () => ({ ok: true, data: null }));
  useSettingsStore.setState({ settings: { ...SETTINGS }, hydrated: false });
});

function renderOnboarding(entry = "/onboarding") {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/placement" element={<div>placement-page</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe("OnboardingPage hydrate failure (T8)", () => {
  it("renders an inline error with Retry instead of a permanent skeleton", async () => {
    boundary.getSettings
      .mockImplementationOnce(async () => ({ ok: false, error: "db open failed" }))
      .mockImplementationOnce(async () => ({ ok: true, data: SETTINGS }));

    renderOnboarding();

    // The persistent inline surface, not a stranded skeleton.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("db open failed");

    // Retry recovers into the real first step.
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(
      await screen.findByText(/What brings you here\?/),
    ).toBeInTheDocument();
    expect(boundary.getSettings).toHaveBeenCalledTimes(2);
  });
});

describe("OnboardingPage step deep link (T7)", () => {
  it("?step=key opens the API-key step directly", async () => {
    renderOnboarding("/onboarding?step=key");

    expect(
      await screen.findByRole("heading", { name: /anthropic api key/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
    expect(screen.queryByText(/What brings you here\?/)).not.toBeInTheDocument();
  });

  it("an unknown step value falls back to the first step", async () => {
    renderOnboarding("/onboarding?step=bogus");

    expect(
      await screen.findByText(/What brings you here\?/),
    ).toBeInTheDocument();
  });
});
