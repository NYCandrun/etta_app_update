import { create } from "zustand";
import type { AppSettings } from "../types/contract";
import type { ThemePreference } from "../lib/theme";
import { applyTheme } from "../lib/theme";

// Single source of truth for app settings. Backend (SQLite settings table) is
// authoritative on disk; this store mirrors it in memory. Components read from
// here — they must not keep a duplicated/derived copy that can drift.
export interface SettingsStore {
  settings: AppSettings;
  hydrated: boolean;
  setSettings: (settings: AppSettings) => void;
  setTheme: (theme: ThemePreference) => void;
}

const DEFAULT_SETTINGS: AppSettings = {
  dailyGoalMinutes: 30,
  theme: "system",
  baseModel: "claude-sonnet-4-6",
  reasoningModel: "claude-opus-4-8",
  newConceptsPerSession: 3,
  notificationsEnabled: false,
  apiKeyPresent: false,
};

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,
  setSettings: (settings) => set({ settings, hydrated: true }),
  setTheme: (theme) =>
    set((state) => {
      applyTheme(theme);
      return { settings: { ...state.settings, theme } };
    }),
}));
