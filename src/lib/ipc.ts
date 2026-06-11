import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppSettings,
  Concept,
  DailySession,
  GamificationState,
  GradedAnswer,
  Question,
} from "../types/contract";

// A concept summary for curriculum browsing (mirrors the Rust ConceptSummary).
export interface ConceptSummary {
  id: string;
  domain: string;
  module: string;
  title: string;
  difficultyTier: number;
}

// One submitted answer: the raw answer only — the frontend NEVER sends a
// correctness flag. Grading is server-authoritative.
export interface SubmittedAnswer {
  questionId: string;
  answer: string;
}

export interface GradeQuizResult {
  answers: GradedAnswer[];
  finalScore: number;
}

// The post-attempt adaptive state returned by record_quiz_result (mirrors the
// Rust RecordedQuizResult). The refreshed gamification snapshot lets the store
// re-sync from the single backend source of truth (never a local increment).
export interface RecordedQuizResult {
  gamification: GamificationState;
  nextReview: string;
  intervalDays: number;
  easeFactor: number;
  masteryScore: number;
}

// Today's tracked study minutes vs. the configured goal (the daily-goal ring
// reads this REAL value — never a hardcoded percentage).
export interface DailyProgress {
  minutesToday: number;
  goalMinutes: number;
}

// The placement outcome (mirrors the Rust PlacementResult): the starting
// concept the learner was placed into and the score that produced it.
export interface PlacementResult {
  conceptId: string;
  domain: string;
  title: string;
  correctCount: number;
  total: number;
}

// Thin typed wrapper over Tauri's invoke. Rust commands return Result<T, String>;
// Tauri rejects the promise on Err. We normalize both branches into IpcResult<T>
// so every caller handles the error branch explicitly (never an empty catch).
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

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
  hasApiKey: () => call<boolean>("has_api_key"),
  testApiKey: () => call<boolean>("test_api_key"),

  // ---- AI + curriculum (milestone 2) ----

  // Model ids for the Settings picker. Uses GET /v1/models (cached); never
  // burns a completion request.
  listAvailableModels: () => call<string[]>("list_available_models"),
  // Real connectivity test: a tiny completion using the CONFIGURED model.
  testConnection: () => call<boolean>("test_connection"),
  // Quiz generation (cached) — returns the validated, schema-repaired questions.
  generateQuiz: (conceptId: string) => call<Question[]>("generate_quiz", { conceptId }),
  // Server-authoritative grading of submitted answers.
  gradeQuiz: (conceptId: string, answers: SubmittedAnswer[]) =>
    call<GradeQuizResult>("grade_quiz", { conceptId, answers }),
  // Curriculum browsing.
  listConcepts: (domain?: string) =>
    call<ConceptSummary[]>("list_concepts", domain ? { domain } : {}),

  // ---- Milestone 3: learning loop + adaptive engine + gamification ----

  // Full gamification snapshot. Fetched ONCE at launch (one provider, not from
  // every shell component independently — blocklist #26).
  getGamificationState: () => call<GamificationState>("get_gamification_state"),
  // Lesson-completion XP, awarded EXACTLY ONCE per concept (backend-guarded).
  awardLessonXp: (conceptId: string) =>
    call<GamificationState>("award_lesson_xp", { conceptId }),
  // Persist a graded quiz and advance the adaptive state (SM-2 + mastery + XP
  // once). The frontend sends back the server-graded answers plus latencies; it
  // never sends a correctness flag of its own (server-authoritative).
  recordQuizResult: (
    conceptId: string,
    answers: GradedAnswer[],
    latenciesMs: (number | null)[],
  ) =>
    call<RecordedQuizResult>("record_quiz_result", {
      conceptId,
      answers,
      latenciesMs,
    }),
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
  // copy; prompts render via the shared KaTeX renderer — blocklist #0f).
  generatePlacementQuiz: () => call<Question[]>("generate_placement_quiz"),
  // Grade placement server-side and place the learner into a starting concept.
  // The frontend sends only raw answers (never a correctness flag).
  placeLearner: (answers: SubmittedAnswer[]) =>
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

// Stream an AI turn (lesson or explain). The backend emits incremental
// `ai://delta` events and resolves with the full text. We subscribe BEFORE
// invoking so no early chunk is missed, and always unlisten on settle.
//
// `mode` is "lesson" or "explain"; `strategy` applies to explain escalation
// ("textbook" | "analogy" | "socratic" | "scaffold"). `userInput` carries the
// learner's reinforcement context / question.
export async function streamGenerate(
  args: {
    conceptId: string;
    mode: "lesson" | "explain";
    strategy?: string;
    userInput?: string;
  },
  onDelta: (chunk: string) => void,
): Promise<IpcResult<string>> {
  let unlisten: (() => void) | null = null;
  try {
    unlisten = await listen<string>("ai://delta", (event) => {
      onDelta(event.payload);
    });
    const data = await invoke<string>("generate_streamed", {
      conceptId: args.conceptId,
      mode: args.mode,
      strategy: args.strategy ?? null,
      userInput: args.userInput ?? null,
    });
    return { ok: true, data };
  } catch (e) {
    const error =
      typeof e === "string" ? e : e instanceof Error ? e.message : "Unexpected error";
    return { ok: false, error };
  } finally {
    if (unlisten) unlisten();
  }
}
