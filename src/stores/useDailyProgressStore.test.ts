import { describe, it, expect, vi, beforeEach } from "vitest";

// T6: errorNotified marks "this failure streak has been SURFACED" — it must
// only flip when an onError callback actually fired. A callback-less refresh
// (the study timer's post-flush refresh passes none) consuming the flag means
// a whole failure streak could surface zero times.

const getDailyProgress = vi.hoisted(() => vi.fn());

vi.mock("../lib/ipc", () => ({
  ipc: { getDailyProgress },
}));

import { useDailyProgressStore } from "./useDailyProgressStore";

beforeEach(() => {
  getDailyProgress.mockReset();
  useDailyProgressStore.setState({
    progress: null,
    inFlight: null,
    errorNotified: false,
  });
});

describe("useDailyProgressStore error surfacing (once per streak)", () => {
  it("does not consume the notification when a callback-less refresh fails", async () => {
    getDailyProgress.mockImplementation(async () => ({
      ok: false,
      error: "db locked",
    }));

    // Study-timer style refresh: no onError registered.
    await useDailyProgressStore.getState().refresh();
    expect(useDailyProgressStore.getState().errorNotified).toBe(false);

    // The NEXT caller that can surface the failure still gets to, exactly once.
    const onError = vi.fn();
    await useDailyProgressStore.getState().refresh(onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(useDailyProgressStore.getState().errorNotified).toBe(true);

    // Further failures in the same streak stay silent (once per streak).
    await useDailyProgressStore.getState().refresh(onError);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("a successful refresh resets the streak so the next failure surfaces again", async () => {
    const onError = vi.fn();
    getDailyProgress.mockImplementationOnce(async () => ({
      ok: false,
      error: "boom",
    }));
    await useDailyProgressStore.getState().refresh(onError);
    expect(onError).toHaveBeenCalledTimes(1);

    getDailyProgress.mockImplementationOnce(async () => ({
      ok: true,
      data: { minutesToday: 5, goalMinutes: 30 },
    }));
    await useDailyProgressStore.getState().refresh(onError);
    expect(useDailyProgressStore.getState().errorNotified).toBe(false);

    getDailyProgress.mockImplementationOnce(async () => ({
      ok: false,
      error: "boom again",
    }));
    await useDailyProgressStore.getState().refresh(onError);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
