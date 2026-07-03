import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useOnboardingStore } from "./stores/useOnboardingStore";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useGamificationStore } from "./stores/useGamificationStore";
import { useDailyProgressStore } from "./stores/useDailyProgressStore";
import { useCurriculumStore } from "./stores/useCurriculumStore";

// Boot-path flow test (H6 + C1): rendering the REAL <App> with only the Tauri
// boundary mocked. A returning user with saved theme:"dark" must get the dark
// theme applied on /dashboard WITHOUT ever visiting Settings (the settings
// store hydrates once at the root), and navigating around must never re-check
// the onboarding flag (done is terminal — no skeleton flash per route change).

const boundary = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: boundary.invoke,
  Channel: class {
    onmessage: (msg: unknown) => void = () => {};
  },
}));

import { App } from "./App";

const SETTINGS = {
  dailyGoalMinutes: 30 as const,
  theme: "dark",
  baseModel: "claude-sonnet-5",
  reasoningModel: "claude-opus-4-8",
  newConceptsPerSession: 3,
  notificationsEnabled: false,
  apiKeyPresent: true,
};

const GAMIFICATION = {
  xp: 120,
  level: { level: 2, title: "Explorer", xpIntoLevel: 20, xpForNextLevel: 80 },
  streak: {
    currentStreak: 3,
    longestStreak: 5,
    freezesAvailable: 0,
    lastActiveDate: "2026-07-02",
  },
  recentXpEvents: [],
  badges: [],
};

beforeEach(() => {
  boundary.invoke.mockReset();
  boundary.invoke.mockImplementation((cmd) => {
    switch (cmd) {
      case "get_settings":
        return Promise.resolve(SETTINGS);
      case "get_onboarding_complete":
        return Promise.resolve(true);
      case "get_gamification_state":
        return Promise.resolve(GAMIFICATION);
      case "build_session":
        return Promise.resolve({
          conceptsNew: [],
          conceptsReview: [],
          interleavedSet: [],
          estimatedMinutes: 0,
        });
      case "get_concept_states":
        return Promise.resolve([]);
      case "get_daily_progress":
        return Promise.resolve({ minutesToday: 5, goalMinutes: 30 });
      case "list_available_models":
        return Promise.resolve([SETTINGS.baseModel]);
      default:
        return Promise.resolve(null);
    }
  });

  // Module-singleton state: fresh boot per test.
  window.location.hash = "";
  document.documentElement.classList.remove("dark");
  useOnboardingStore.setState({ status: "unknown", error: null });
  useSettingsStore.setState({
    settings: { ...SETTINGS, theme: "system" },
    hydrated: false,
  });
  useGamificationStore.setState({ state: null });
  useDailyProgressStore.setState({
    progress: null,
    inFlight: null,
    errorNotified: false,
  });
  useCurriculumStore.setState({ concepts: {} });
});

describe("App boot (H6 settings hydration + C1 one-shot gate)", () => {
  it("applies the saved dark theme on the dashboard without visiting Settings", async () => {
    render(<App />);

    // Returning user lands on the dashboard (gate passes, no bounce)…
    expect(await screen.findByText("Welcome back")).toBeInTheDocument();
    // …and the persisted theme was applied by root hydration, not by any
    // Settings-page visit (H6: the OS is light here — matchMedia stub says
    // no dark preference — so "dark" can ONLY come from the store).
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    // (The localStorage boot-cache mirror is covered by theme.test.ts; this
    // jsdom build exposes no localStorage, which applyTheme tolerates.)
  });

  it("never re-checks the onboarding flag when navigating (done is terminal)", async () => {
    render(<App />);
    await screen.findByText("Welcome back");

    const gateChecks = () =>
      boundary.invoke.mock.calls.filter(
        ([cmd]) => cmd === "get_onboarding_complete",
      ).length;
    expect(gateChecks()).toBe(1);

    // Navigate via the sidebar; the gate must not re-fetch (no skeleton flash).
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    expect(await screen.findByText("Welcome back")).toBeInTheDocument();

    expect(gateChecks()).toBe(1);
  });
});
