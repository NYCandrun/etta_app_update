import { create } from "zustand";

// Sidebar-navigation leave guard. react-router's useBlocker needs a data
// router, and the app deliberately uses the declarative <HashRouter>
// (blocklist #14), so in-progress pages register a guard here instead and
// AppLayout consults it before following a nav link.
//
// The guard returns true when it BLOCKED the navigation (the page then shows
// its own inline confirm UI and, on confirm, navigates to `to` itself).
export type LeaveGuardFn = (to: string) => boolean;

export interface LeaveGuardStore {
  guard: LeaveGuardFn | null;
  setGuard: (guard: LeaveGuardFn) => void;
  /** Clears only if `guard` is still the registered one (unmount safety). */
  clearGuard: (guard: LeaveGuardFn) => void;
}

export const useLeaveGuardStore = create<LeaveGuardStore>((set) => ({
  guard: null,
  setGuard: (guard) => set({ guard }),
  clearGuard: (guard) =>
    set((state) => (state.guard === guard ? { guard: null } : state)),
}));
