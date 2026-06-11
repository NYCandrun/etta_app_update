import { create } from "zustand";
import type { DailySession } from "../types/contract";

// Single source of truth for the active daily learning session. Built by the
// backend (interleaving + SRS queue) and held here for the duration of the
// session. Components read the queue from here rather than recomputing.
export interface SessionStore {
  session: DailySession | null;
  activeConceptId: string | null;
  setSession: (session: DailySession) => void;
  setActiveConcept: (conceptId: string | null) => void;
  clearSession: () => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  session: null,
  activeConceptId: null,
  setSession: (session) => set({ session }),
  setActiveConcept: (activeConceptId) => set({ activeConceptId }),
  clearSession: () => set({ session: null, activeConceptId: null }),
}));
