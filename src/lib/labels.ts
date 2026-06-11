// Standardized, app-wide button/action labels (blocklist #19). Import from
// here instead of hardcoding strings so quiz submission, navigation, etc. read
// identically on every screen.
export const LABELS = {
  // The quiz answer submit action is ALWAYS "Check Answer" — never a mix of
  // "Submit" / "Check" / "Continue".
  checkAnswer: "Check Answer",
  nextQuestion: "Next Question",
  startLearning: "Start Learning",
  retry: "Retry",
  saveSettings: "Save Settings",
  continue: "Continue",
} as const;

export type LabelKey = keyof typeof LABELS;
