import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { ToastProvider } from "../components/ui";
import { useDailyProgressStore } from "../stores/useDailyProgressStore";

// H13: the study timer must accumulate SECONDS and flush whole minutes,
// carrying the sub-minute remainder across flushes AND across screen mounts.
// The v1 bug: Math.floor per screen mount dropped up to 59s per navigation
// (90s lesson + 90s quiz recorded 2 minutes instead of 3).

const addStudyMinutes = vi.hoisted(() => vi.fn());
const getDailyProgress = vi.hoisted(() => vi.fn());

vi.mock("./ipc", () => ({
  ipc: {
    addStudyMinutes,
    getDailyProgress,
  },
}));

import { useStudyTimer, resetStudyTimerForTests } from "./useStudyTimer";

function TimerHost() {
  useStudyTimer();
  return null;
}

function renderTimer() {
  return render(
    <ToastProvider>
      <TimerHost />
    </ToastProvider>,
  );
}

function totalMinutesSent(): number {
  return addStudyMinutes.mock.calls.reduce(
    (sum, [minutes]) => sum + (minutes as number),
    0,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  addStudyMinutes.mockReset();
  getDailyProgress.mockReset();
  addStudyMinutes.mockImplementation(async () => ({ ok: true, data: null }));
  getDailyProgress.mockImplementation(async () => ({
    ok: true,
    data: { minutesToday: 0, goalMinutes: 30 },
  }));
  resetStudyTimerForTests();
  useDailyProgressStore.setState({
    progress: null,
    inFlight: null,
    errorNotified: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
  // Remove any per-test visibilityState override (shadowing own property).
  delete (document as { visibilityState?: string }).visibilityState;
});

// Shadow document.visibilityState (normally on the prototype) and fire the
// event, mimicking the webview hiding/showing the window.
function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useStudyTimer (H13)", () => {
  it("records 3 minutes for 90s + 90s across two mounts (remainder carries)", () => {
    // Mount 1: 90 seconds on a lesson.
    const first = renderTimer();
    act(() => {
      vi.advanceTimersByTime(60_000); // minute tick → flush 1 min
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    first.unmount(); // 30s remainder carries — nothing flushable yet
    expect(totalMinutesSent()).toBe(1);

    // Mount 2: 90 seconds on the quiz.
    const second = renderTimer();
    act(() => {
      vi.advanceTimersByTime(60_000); // tick: carried 30s + 60s → 1 min, 30s left
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    second.unmount(); // carried 30s + 30s = 60s → 1 more minute

    // The v1 bug recorded 2 (floor(90s) per mount); the fix records 3.
    expect(totalMinutesSent()).toBe(3);
  });

  it("flushes every 60s while mounted (quitting loses <60s, never the visit)", () => {
    renderTimer();
    act(() => {
      vi.advanceTimersByTime(180_000);
    });
    expect(totalMinutesSent()).toBe(3);
  });

  it("pagehide rounds a remainder >= 30s up to a minute (best-effort quit flush)", () => {
    renderTimer();
    act(() => {
      vi.advanceTimersByTime(45_000);
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(totalMinutesSent()).toBe(1);

    // The rounded remainder was consumed — an immediately following unmount
    // must NOT double-count it.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(totalMinutesSent()).toBe(1);
  });

  it("does not round tiny remainders on pagehide (<30s is dropped, documented)", () => {
    renderTimer();
    act(() => {
      vi.advanceTimersByTime(20_000);
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(addStudyMinutes).not.toHaveBeenCalled();
  });

  // T3a: hidden time is NOT study time — interval ticks that fire while the
  // document is hidden must accrue nothing, and returning visible restarts
  // the clock instead of crediting the hidden window.
  it("does not accrue study minutes while the document is hidden", () => {
    renderTimer();

    // 45 visible seconds, then hide: best-effort flush rounds up to 1 minute.
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    act(() => {
      setVisibility("hidden");
    });
    expect(totalMinutesSent()).toBe(1);

    // Five interval ticks fire while hidden — pure hidden time, zero credit.
    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    expect(totalMinutesSent()).toBe(1);

    // Back to visible: the clock restarts at "now"; only NEW visible time
    // counts (the hidden window is never retroactively credited). The
    // interval is anchored at mount, so cross TWO ticks (>60 visible seconds
    // guaranteed) and expect exactly one more minute.
    act(() => {
      setVisibility("visible");
    });
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(totalMinutesSent()).toBe(2);
  });

  it("discards a hidden window even when the first tick fires before the visible event (wake race)", () => {
    renderTimer();
    act(() => {
      setVisibility("hidden");
    });
    expect(addStudyMinutes).not.toHaveBeenCalled(); // <30s remainder dropped

    // Simulate wake: a resumed interval callback spanning the whole hidden
    // window runs BEFORE the visibilitychange→visible handler.
    act(() => {
      vi.advanceTimersByTime(3_600_000); // an hour hidden — 60 tick callbacks
    });
    act(() => {
      setVisibility("visible");
    });
    expect(totalMinutesSent()).toBe(0);

    // Normal counting resumes after return.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(totalMinutesSent()).toBe(1);
  });

  // T3b: a failed flush must RE-CREDIT its minutes so the next flush retries
  // them — never silently under-count tracked time on a recoverable error.
  it("re-credits minutes from a failed flush so the next flush retries them", async () => {
    addStudyMinutes.mockImplementationOnce(async () => ({
      ok: false,
      error: "db locked",
    }));

    renderTimer();
    act(() => {
      vi.advanceTimersByTime(60_000); // tick 1: flush 1 minute → FAILS
    });
    // Let the failed addStudyMinutes promise settle (re-credit happens there).
    await act(async () => {
      await Promise.resolve();
    });
    expect(addStudyMinutes).toHaveBeenNthCalledWith(1, 1);

    act(() => {
      vi.advanceTimersByTime(60_000); // tick 2: 1 new + 1 re-credited minute
    });
    expect(addStudyMinutes).toHaveBeenNthCalledWith(2, 2);
  });

  it("refreshes the shared daily-progress store after a successful flush (H12)", async () => {
    renderTimer();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // Let the addStudyMinutes promise chain settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(getDailyProgress).toHaveBeenCalled();
  });
});
