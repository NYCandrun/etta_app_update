import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AnswerSubmission,
  AppSettings,
  Concept,
  DailyProgress,
  DailySession,
  GamificationState,
  IpcResult,
  PlacementResult,
  QuizOutcome,
  QuizPayload,
  WireQuestion,
} from "../types/contract";

// Re-export for callers that import the envelope from here.
export type { IpcResult } from "../types/contract";

// Thin typed wrapper over Tauri's invoke. Rust commands return Result<T, String>;
// Tauri rejects the promise on Err. We normalize both branches into IpcResult<T>
// (see contract.ts — the envelope is synthesized HERE, client-side) so every
// caller handles the error branch explicitly (never an empty catch).
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<IpcResult<T>> {
  try {
    const data = await invoke<T>(cmd, args);
    return { ok: true, data };
  } catch (e) {
    const error = typeof e === "string" ? e : e instanceof Error ? e.message : "Unexpected error";
    return { ok: false, error };
  }
}

export const ipc = {
  getSettings: () => call<AppSettings>("get_settings"),
  setSetting: (key: string, value: string) => call<null>("set_setting", { key, value }),
  setApiKey: (key: string) => call<null>("set_api_key", { key }),
  deleteApiKey: () => call<null>("delete_api_key"),

  // ---- AI + curriculum (milestone 2) ----

  // Model ids for the Settings picker. Uses GET /v1/models (cached); never
  // burns a completion request.
  listAvailableModels: () => call<string[]>("list_available_models"),
  // Real connectivity test: a tiny completion using the CONFIGURED model.
  testConnection: () => call<boolean>("test_connection"),
  // Quiz generation (cached). Returns REDACTED questions — no answer key ever
  // reaches the webview (H10); the canonical copy stays server-side — plus
  // the quizId nonce identifying THIS served instance (hand it back to
  // gradeAndRecordQuiz so grading pins the exact quiz that was answered).
  generateQuiz: (conceptId: string) => call<QuizPayload>("generate_quiz", { conceptId }),
  // Cancel an in-flight stream by its requestId. Always safe: an unknown or
  // already-settled id is a backend no-op. The cancelled stream itself
  // resolves with a marked error that isCancelledError detects.
  cancelStream: (requestId: string) => call<null>("cancel_stream", { requestId }),
  // Cheap cache-presence probe for offline UX (consumed in WP3).
  isCached: (conceptId: string, contentType: string) =>
    call<boolean>("is_cached", { conceptId, contentType }),

  // ---- Milestone 3: learning loop + adaptive engine + gamification ----

  // Full gamification snapshot. Fetched ONCE at launch (one provider, not from
  // every shell component independently — blocklist #26).
  getGamificationState: () => call<GamificationState>("get_gamification_state"),
  // Lesson-completion XP, awarded EXACTLY ONCE per concept (backend-guarded).
  awardLessonXp: (conceptId: string) =>
    call<GamificationState>("award_lesson_xp", { conceptId }),
  // Grade AND persist a whole quiz in ONE server-side command. quizId is the
  // nonce generateQuiz returned — grading loads exactly that served instance
  // (an unknown/expired id gets a friendly "quiz expired" error). We send
  // only {questionId, answer, latencyMs} — never a correctness flag; graded
  // answers never round-trip through the webview. The submission must cover
  // every question exactly once. On recorded:false the score is still
  // returned and retryPersist(retryToken) re-persists the server-held result.
  gradeAndRecordQuiz: (conceptId: string, quizId: string, answers: AnswerSubmission[]) =>
    call<QuizOutcome>("grade_and_record_quiz", { conceptId, quizId, answers }),
  // Retry ONLY the persist step of an already-graded quiz (no re-grading, no
  // model calls). The token is the retryToken from a recorded:false outcome.
  retryPersist: (token: string) => call<QuizOutcome>("retry_persist", { token }),
  // Build today's adaptive session (new + review, interleaved).
  buildSession: () => call<DailySession>("build_session"),
  // Every concept with decay-adjusted effective mastery + UI gating state.
  getConceptStates: () => call<Concept[]>("get_concept_states"),
  // Track real study minutes for today (feeds the daily-goal ring).
  addStudyMinutes: (minutes: number) =>
    call<null>("add_study_minutes", { minutes }),
  // Today's tracked minutes + goal, so the ring renders a real ratio.
  getDailyProgress: () => call<DailyProgress>("get_daily_progress"),

  // ---- Milestone 4: onboarding + placement ----

  // Has first-run onboarding + placement been completed? Gates routing.
  getOnboardingComplete: () => call<boolean>("get_onboarding_complete"),
  // Generate the 5-question placement micro-quiz (server holds the canonical
  // copy; the wire questions are redacted — H10; prompts render via the shared
  // KaTeX renderer — blocklist #0f).
  generatePlacementQuiz: () => call<WireQuestion[]>("generate_placement_quiz"),
  // Grade placement server-side and place the learner into a starting concept.
  // The frontend sends only raw answers (never a correctness flag), exactly
  // one per placement question.
  placeLearner: (answers: AnswerSubmission[]) =>
    call<PlacementResult>("place_learner", { answers }),
  // Skip placement: seed the foundational base + mark onboarding complete so the
  // learner can pick an unlocked concept from the curriculum diagram instead.
  skipPlacement: () => call<null>("skip_placement"),

  // ---- Milestone 5: data export ----

  // Complete user-data export as a pretty-printed JSON string. Contains no
  // secrets (the key stays in the keychain) and no file paths (scrubbed
  // server-side). The caller writes this to a user-chosen file.
  exportData: () => call<string>("export_data"),
};

// Stable marker the backend puts on errors caused by a rejected API key
// (401/403 from Anthropic — see INVALID_API_KEY_MARKER in
// src-tauri/src/ai/client.rs; keep in sync). Pages use isApiKeyError to
// render a "Fix API key in Settings" hint next to the error.
export const INVALID_API_KEY_MARKER = "EttaError:api_key";

/** True when a command error means "the configured API key was rejected". */
export function isApiKeyError(error: string): boolean {
  // includes(), not startsWith(): some call paths prefix context onto the
  // backend string before it reaches the UI.
  return error.includes(INVALID_API_KEY_MARKER);
}

// Stable prefix the backend puts on the error of a stream the user cancelled
// (see STREAM_CANCELLED_MARKER in src-tauri/src/ai/client.rs — keep in sync).
// A cancellation the frontend asked for is not a failure: callers detect it
// with isCancelledError and swallow it silently.
export const STREAM_CANCELLED_MARKER = "EttaError:cancelled";

/** True when a streamGenerate error means "you cancelled this yourself". */
export function isCancelledError(error: string): boolean {
  return error.startsWith(STREAM_CANCELLED_MARKER);
}

// Machine markers ("EttaError:<kind>:") exist for DETECTION (isApiKeyError /
// isCancelledError above) — they are not learner-facing copy. Every path that
// puts a backend error string on screen (InlineError cards, toasts) must run
// it through formatIpcError first; detection call sites keep the RAW string.
const ERROR_MARKER_RE = /EttaError:(?:api_key|cancelled):?\s*/g;

/** Strip machine marker prefixes from an error before showing it to the user. */
export function formatIpcError(error: string): string {
  const cleaned = error.replace(ERROR_MARKER_RE, "").trim();
  return cleaned === "" ? "The request was interrupted." : cleaned;
}

// Stream an AI turn (lesson or explain). Deltas arrive through a
// PER-INVOCATION Channel — never a global event — so concurrent or superseded
// streams can never cross-talk (H7). Resolves with the FULL text, which
// callers treat as authoritative over the accumulated deltas.
//
// `requestId` is frontend-generated (crypto.randomUUID()) and identifies the
// stream to ipc.cancelStream. `mode` is "lesson" or "explain":
// - lesson: the BACKEND decides reinforcement from the learner's real recent
//   mistakes (C3) — no user input is sent from here;
// - explain: `strategy` ("textbook" | "analogy" | "socratic" | "scaffold")
//   and `userInput` (the learner's question) pass through; never cached.
export async function streamGenerate(
  args: {
    requestId: string;
    conceptId: string;
    mode: "lesson" | "explain";
    /** explain only: the escalation-ladder strategy. */
    strategy?: string;
    /** explain only: the learner's question. Lessons never send input (C3). */
    userInput?: string;
  },
  onDelta: (chunk: string) => void,
): Promise<IpcResult<string>> {
  const channel = new Channel<string>();
  channel.onmessage = onDelta;
  try {
    const data = await invoke<string>("generate_streamed", {
      requestId: args.requestId,
      conceptId: args.conceptId,
      mode: args.mode,
      strategy: args.strategy ?? null,
      userInput: args.userInput ?? null,
      onDelta: channel,
    });
    return { ok: true, data };
  } catch (e) {
    const error =
      typeof e === "string" ? e : e instanceof Error ? e.message : "Unexpected error";
    return { ok: false, error };
  }
}
