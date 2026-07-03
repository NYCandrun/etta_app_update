// Standardized, app-wide button/action labels (blocklist #19). Import from
// here instead of hardcoding strings so quiz submission, navigation, etc. read
// identically on every screen. Every entry here MUST have a consumer — dead
// entries (nextQuestion, saveSettings) were deleted rather than left as
// aspirational strings.
export const LABELS = {
  // Quiz/placement advance actions: "Next" between questions, an explicit
  // finish label on the last one (the button advances/submits — it never
  // reveals per-question correctness, so "Check Answer" was a lie; WP3).
  next: "Next",
  finishQuiz: "Finish quiz",
  finishPlacement: "Finish placement",
  startLearning: "Start Learning",
  // Shared by ErrorToast and InlineError (and any page-level retry actions).
  retry: "Retry",
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
