import { create } from "zustand";
import type { GamificationState } from "../types/contract";

// Single source of truth for XP / level / streak / badges. The BACKEND owns the
// real values (XP is computed and persisted server-side to prevent double-XP,
// blocklist #1/#12); this store only mirrors the last synced snapshot. No
// component may recompute or duplicate these numbers locally.
export interface GamificationStore {
  state: GamificationState | null; // null until first sync from backend
  setState: (state: GamificationState) => void;
}

export const useGamificationStore = create<GamificationStore>((set) => ({
  state: null,
  setState: (state) => set({ state }),
}));
