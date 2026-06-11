import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, GradedAnswer, Question } from "../types/contract";

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
};
