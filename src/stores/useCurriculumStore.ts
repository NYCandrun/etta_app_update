import { create } from "zustand";
import type { Concept } from "../types/contract";

// Single source of truth for the concept graph / curriculum state. Keyed by
// concept id so lookups are O(1) and there is exactly one record per concept
// (no duplicated/derived copies that can drift). Gating decisions read
// `effectiveMastery` from these records.
export interface CurriculumStore {
  concepts: Record<string, Concept>;
  setConcepts: (concepts: Concept[]) => void;
  upsertConcept: (concept: Concept) => void;
}

export const useCurriculumStore = create<CurriculumStore>((set) => ({
  concepts: {},
  setConcepts: (concepts) =>
    set({
      concepts: Object.fromEntries(concepts.map((c) => [c.id, c])),
    }),
  upsertConcept: (concept) =>
    set((state) => ({
      concepts: { ...state.concepts, [concept.id]: concept },
    })),
}));
