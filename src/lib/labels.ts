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

// Render a human module label from a module id like "alg_m01" -> "Module 1"
// (blocklist #28d). v1 used `.slice(-1)`, which turned "alg_m01" into "1" only
// by luck and broke entirely at "alg_m10" (-> "0") / "alg_m12" (-> "2"). Here we
// extract the trailing digit run after the "_m" marker and parse it as a number,
// so "alg_m01" -> 1, "alg_m10" -> 10, "alg_m12" -> 12. Falls back to showing the
// raw id when the shape is unrecognized (never a silently-wrong number).
export function formatModuleLabel(module: string): string {
  const match = /_m0*(\d+)$/.exec(module);
  if (match) {
    return `Module ${Number(match[1])}`;
  }
  return module;
}
