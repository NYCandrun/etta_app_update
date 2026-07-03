import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ToastProvider } from "../components/ui";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { AppSettings } from "../types/contract";
import type { IpcResult } from "../lib/ipc";

// T5: optimistic-write rollbacks must be FIELD-granular and applied against
// the store's CURRENT snapshot. A whole-settings snapshot captured at handler
// start would revert unrelated fields whose own concurrent writes succeeded
// (store desyncs from disk — the H6 invariant).

const boundary = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setSetting: vi.fn(),
  setApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  listAvailableModels: vi.fn(),
  testConnection: vi.fn(),
  exportData: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return { ...actual, ipc: boundary };
});

// The Tauri dialog/fs plugins touch the webview bridge — stub them out.
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn() }));

import { SettingsPage } from "./SettingsPage";

const SETTINGS: AppSettings = {
  dailyGoalMinutes: 30,
  theme: "light",
  baseModel: "claude-sonnet-4-6",
  reasoningModel: "claude-opus-4-8",
  newConceptsPerSession: 3,
  notificationsEnabled: false,
  apiKeyPresent: true,
};

beforeEach(() => {
  for (const fn of Object.values(boundary)) fn.mockReset();
  boundary.getSettings.mockImplementation(async () => ({ ok: true, data: SETTINGS }));
  boundary.setSetting.mockImplementation(async () => ({ ok: true, data: null }));
  boundary.listAvailableModels.mockImplementation(async () => ({
    ok: true,
    data: [SETTINGS.baseModel],
  }));
  // Module-singleton store: reset between tests.
  useSettingsStore.setState({ settings: { ...SETTINGS }, hydrated: false });
});

function renderSettings() {
  return render(
    <ToastProvider>
      <SettingsPage />
    </ToastProvider>,
  );
}

describe("SettingsPage rollback granularity (T5)", () => {
  it("a failing goal write rolls back ONLY the goal, not a concurrently-succeeded theme change", async () => {
    let settleGoal: (v: IpcResult<null>) => void = () => {};
    boundary.setSetting.mockImplementation((key: string) => {
      if (key === "daily_goal_minutes") {
        // Keep the goal write in flight while the theme write completes.
        return new Promise<IpcResult<null>>((resolve) => (settleGoal = resolve));
      }
      return Promise.resolve({ ok: true, data: null });
    });

    renderSettings();
    await screen.findByRole("heading", { name: "Settings" });

    // Rapid pair: goal write hangs in flight…
    fireEvent.click(screen.getByRole("button", { name: "45 min" }));
    // …while the theme write starts AND succeeds.
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );

    // Now the goal write fails → only the GOAL field reverts.
    await act(async () => {
      settleGoal({ ok: false, error: "disk full" });
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "30 min" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(screen.getByRole("button", { name: "45 min" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // The theme survived: its own write succeeded and must NOT be reverted by
    // the goal handler's stale snapshot.
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(useSettingsStore.getState().settings.theme).toBe("dark");
    expect(useSettingsStore.getState().settings.dailyGoalMinutes).toBe(30);
  });

  it("skips the rollback when a newer write already changed the same field", async () => {
    const settlers: Array<(v: IpcResult<null>) => void> = [];
    boundary.setSetting.mockImplementation((key: string) => {
      if (key === "daily_goal_minutes") {
        return new Promise<IpcResult<null>>((resolve) => settlers.push(resolve));
      }
      return Promise.resolve({ ok: true, data: null });
    });

    renderSettings();
    await screen.findByRole("heading", { name: "Settings" });

    // Two rapid goal clicks: 45 (will fail) then 60 (succeeds).
    fireEvent.click(screen.getByRole("button", { name: "45 min" }));
    fireEvent.click(screen.getByRole("button", { name: "60 min" }));
    await act(async () => {
      settlers[1]?.({ ok: true, data: null });
    });
    await act(async () => {
      settlers[0]?.({ ok: false, error: "disk full" });
    });

    // The failed FIRST write must not clobber the succeeded second one.
    expect(useSettingsStore.getState().settings.dailyGoalMinutes).toBe(60);
    expect(screen.getByRole("button", { name: "60 min" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("SettingsPage hydrate failure", () => {
  it("renders an inline error with Retry instead of a permanent skeleton", async () => {
    boundary.getSettings
      .mockImplementationOnce(async () => ({ ok: false, error: "db locked" }))
      .mockImplementationOnce(async () => ({ ok: true, data: SETTINGS }));

    renderSettings();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("db locked");

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(boundary.getSettings).toHaveBeenCalledTimes(2);
  });
});
