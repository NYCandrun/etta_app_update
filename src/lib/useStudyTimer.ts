import { useEffect } from "react";
import { ipc } from "./ipc";
import { useToast } from "../components/ui";
import { useDailyProgressStore } from "../stores/useDailyProgressStore";

// Track real study time on a learning screen and persist it (blocklist #25/H1:
// the daily-goal ring reads REAL tracked minutes, never a hardcoded percentage).
//
// H13 design (binding): accumulate SECONDS and flush whole minutes
//   - every 60s while mounted (so quitting the app mid-screen loses <60s,
//     never the whole visit), and
//   - on visibilitychange→hidden / pagehide (webview-reliable "maybe quitting"
//     signals), where a best-effort remainder >= 30s rounds up to 1 minute
//     because there may be no later chance to flush it, and
//   - on unmount (navigation between screens).
// The sub-minute remainder CARRIES across flushes and across screen mounts
// (module-level accumulator), so 90s on a lesson + 90s on its quiz records
// 3 minutes, not 2. Residual loss is honest and bounded: a hard kill between
// ticks loses under 60 seconds (under 30 after a pagehide flush).
//
// Time while the document is hidden is NOT study time: going hidden flushes,
// and coming back visible restarts the clock at "now".
//
// Flushes stay fire-and-forget (they must never block navigation). Failures
// are logged and surfaced via ONE toast per failure streak — never a toast
// per tick. A successful flush refreshes the shared daily-progress store so
// the goal ring advances live (H12).

// Sub-minute seconds carried across flushes AND across mounts (app-session
// scoped; losing it on quit costs <60s, documented above).
let carrySeconds = 0;
// One toast per failure streak; reset by the next successful flush.
let flushErrorNotified = false;
// A failed flush RE-CREDITS its minutes into carrySeconds so the next flush
// retries them (add_study_minutes is additive, so the retry is safe). The
// carry is bounded so a permanently failing backend can't grow an unbounded
// balance that later lands as a single absurd credit.
const MAX_CARRY_SECONDS = 240 * 60;

/** Test hook: reset the module-level accumulator between tests. */
export function resetStudyTimerForTests(): void {
  carrySeconds = 0;
  flushErrorNotified = false;
}

export function useStudyTimer(): void {
  const { showError } = useToast();

  useEffect(() => {
    let lastCheckpoint = Date.now();
    // Whether we are inside a hidden period. While true, flush() accrues
    // NOTHING — hidden time is not study time. Tracked as our own flag (not a
    // live document.visibilityState read) so a resumed interval callback that
    // fires on wake BEFORE the visibilitychange event still sees the hidden
    // period it slept through and discards it.
    let hidden =
      typeof document !== "undefined" && document.visibilityState === "hidden";

    const send = (minutes: number) => {
      void ipc.addStudyMinutes(minutes).then((res) => {
        if (res.ok) {
          flushErrorNotified = false;
          // Keep the goal ring live (H12). No toast here — the ring hiding
          // plus the store's own once-per-streak surfacing handle it.
          void useDailyProgressStore.getState().refresh();
          return;
        }
        console.error("addStudyMinutes failed:", res.error);
        // Re-credit the un-persisted minutes (bounded) so the next flush
        // retries them instead of silently under-counting tracked time.
        carrySeconds = Math.min(carrySeconds + minutes * 60, MAX_CARRY_SECONDS);
        if (!flushErrorNotified) {
          flushErrorNotified = true;
          showError(`Could not save your study time: ${res.error}`);
        }
      });
    };

    // Accrue seconds since the last checkpoint, flush whole minutes, keep the
    // remainder. `roundRemainder` is the pagehide/hidden best-effort path:
    // a remainder >= 30s becomes 1 minute (there may be no next flush).
    // While hidden, elapsed wall time is NOT accrued (the checkpoint still
    // advances so a stale window is never counted after returning visible).
    const flush = (roundRemainder: boolean) => {
      const now = Date.now();
      if (!hidden) {
        carrySeconds += Math.max(0, Math.floor((now - lastCheckpoint) / 1000));
      }
      lastCheckpoint = now;
      let minutes = Math.floor(carrySeconds / 60);
      carrySeconds -= minutes * 60;
      if (roundRemainder && carrySeconds >= 30) {
        minutes += 1;
        carrySeconds = 0;
      }
      if (minutes > 0) send(minutes);
    };

    const interval = setInterval(() => flush(false), 60_000);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        // Checkpoint the visible time up to this moment, THEN mark hidden so
        // every later tick (or a wake-up tick spanning the whole hidden
        // window) accrues nothing.
        flush(true);
        hidden = true;
      } else {
        // Hidden time is not study time — restart the clock on return.
        hidden = false;
        lastCheckpoint = Date.now();
      }
    };
    const onPageHide = () => flush(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      // Unmount (in-app navigation): flush whole minutes; the sub-minute
      // remainder carries to the next learning screen via `carrySeconds`.
      flush(false);
    };
  }, [showError]);
}
