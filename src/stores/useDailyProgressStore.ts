import { create } from "zustand";
import type { DailyProgress } from "../types/contract";
import { ipc } from "../lib/ipc";

// Single fetch owner for today's minutes + goal (H12). The header ring and the
// dashboard ring both read THIS store, so they can never drift apart. Refresh
// happens on mount of either ring, on route changes into the dashboard (the
// dashboard instance remounts), and after every study-minute flush
// (useStudyTimer calls refresh()).
//
// Errors: the ring hides gracefully (progress stays null / stale) and the
// optional onError callback fires AT MOST ONCE per failure streak — a flaky
// backend must not stack a toast per retry tick.
export interface DailyProgressStore {
  progress: DailyProgress | null;
  /** In-flight dedup handle (not for rendering). */
  inFlight: Promise<void> | null;
  /** Whether the current failure streak has already been surfaced. */
  errorNotified: boolean;
  refresh: (onError?: (message: string) => void) => Promise<void>;
}

export const useDailyProgressStore = create<DailyProgressStore>((set, get) => ({
  progress: null,
  inFlight: null,
  errorNotified: false,
  refresh: (onError) => {
    const existing = get().inFlight;
    if (existing) return existing;
    const p = ipc.getDailyProgress().then((res) => {
      if (res.ok) {
        set({ progress: res.data, inFlight: null, errorNotified: false });
        return;
      }
      // Keep any previous (stale-but-real) value; surface once per streak.
      // The streak only counts as "notified" when a callback actually FIRED —
      // a callback-less refresh (e.g. the study timer's post-flush refresh)
      // must not consume the one notification a later caller would surface.
      if (!get().errorNotified && onError) {
        set({ inFlight: null, errorNotified: true });
        onError(`Could not load today's progress: ${res.error}`);
      } else {
        set({ inFlight: null });
      }
    });
    set({ inFlight: p });
    return p;
  },
}));
