import { create } from "zustand";
import { ipc } from "../lib/ipc";

// First-run onboarding flag (C1). Hydrated ONCE at boot by the gate; after
// that, `done` is TERMINAL — nothing ever re-checks the backend, so navigating
// never re-fetches (and never flashes the gate skeleton). Both placement
// completion paths (place_learner success AND skip) call `markComplete()`
// so the gate lets the learner through immediately, without an app relaunch.
export type OnboardingStatus =
  | "unknown" // before the first hydrate() call
  | "checking" // first fetch in flight
  | "error" // fetch failed — gate shows an error card with Retry
  | "pending" // backend says onboarding is NOT complete yet
  | "done"; // TERMINAL — never re-checked

export interface OnboardingStore {
  status: OnboardingStatus;
  error: string | null;
  /** Fetch the flag from the backend. Idempotent: only runs from `unknown`
   * (first boot) or `error` (Retry) — `done` and `pending` never re-fetch. */
  hydrate: () => void;
  /** Flip to the terminal `done` state (placement success or skip). */
  markComplete: () => void;
}

export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  status: "unknown",
  error: null,
  hydrate: () => {
    const { status } = get();
    if (status !== "unknown" && status !== "error") return;
    set({ status: "checking", error: null });
    void ipc.getOnboardingComplete().then((res) => {
      // done is terminal: a markComplete() that landed while the fetch was in
      // flight must never be downgraded by a stale response.
      if (get().status === "done") return;
      if (!res.ok) {
        set({ status: "error", error: res.error });
        return;
      }
      set({ status: res.data ? "done" : "pending", error: null });
    });
  },
  markComplete: () => set({ status: "done", error: null }),
}));
