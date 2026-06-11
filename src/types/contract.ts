// Shared FE/BE type contract — SINGLE SOURCE OF TRUTH for IPC (Appendix C).
//
// These interfaces mirror the Rust structs in `src-tauri/src/contract.rs`
// 1:1. Rust serializes with `#[serde(rename_all = "camelCase")]`; these
// camelCase fields must match exactly. A round-trip test
// (`src/types/contract.roundtrip.test.ts`) asserts the JSON shape produced
// by Rust matches these interfaces. Do NOT define divergent shapes elsewhere.

// ---- Gamification ----
export interface GamificationState {
  xp: number; // total XP (backend is source of truth)
  level: LevelInfo;
  streak: StreakInfo;
  recentXpEvents: XpEvent[]; // last ~20
  badges: Badge[];
}
export interface LevelInfo {
  level: number;
  title: string; // Etta-themed level title (app name only — never a legacy name)
  xpIntoLevel: number;
  xpForNextLevel: number;
}
export interface StreakInfo {
  currentStreak: number;
  longestStreak: number;
  freezesAvailable: number;
  lastActiveDate: string; // YYYY-MM-DD
}
export interface XpEvent {
  amount: number;
  source: string;
  description: string;
  createdAt: string; // ISO 8601
}
export interface Badge {
  id: string;
  name: string;
  iconName: string; // SVG/icon asset key, NOT an emoji
  earnedAt: string | null;
}

// ---- Concepts & curriculum ----
export interface Concept {
  id: string;
  domain: string;
  module: string;
  title: string;
  prerequisites: string[];
  learningObjectives: string[];
  difficultyTier: number; // 1-5
  errorPatterns: string[];
  masteryScore: number; // 0-1
  effectiveMastery: number; // decay-adjusted; what the gate uses
  easeFactor: number;
  intervalDays: number;
  nextReview: string | null; // YYYY-MM-DD
  state: "completed" | "in_progress" | "unlocked" | "locked";
}

// ---- Quiz (locked schema; mirrors Appendix A.1/A.3) ----
export type QuestionType = "multiple_choice" | "fill_in_blank" | "free_response";
export interface QuizOption {
  id: string;
  text: string;
  isCorrect: boolean;
}
export interface Question {
  id: string; // "q1".."q10"
  type: QuestionType;
  prompt: string; // may contain $...$ LaTeX
  options?: QuizOption[]; // multiple_choice only
  blanks?: string[]; // fill_in_blank only
  rubric?: string; // free_response only
  explanation: string;
  difficulty: number; // 1-5
  isTransfer: boolean;
}
export interface GradedAnswer {
  questionId: string;
  userAnswer: string;
  isCorrect: boolean; // computed SERVER-side, never trusted from FE
  score: number; // 0-1
  errorPatternDetected: string | null;
}
export interface QuizResult {
  conceptId: string;
  answers: GradedAnswer[];
  finalScore: number; // MUST include the last answer (catches bug 0e)
}

// ---- Session ----
export interface DailySession {
  conceptsNew: string[]; // may be >1 (scaled by daily goal)
  conceptsReview: string[];
  interleavedSet: string[]; // MUST be populated (interleaving actually called)
  estimatedMinutes: number;
}

// ---- Settings ----
export interface AppSettings {
  dailyGoalMinutes: 15 | 30 | 45 | 60;
  theme: "light" | "dark" | "system";
  baseModel: string; // e.g. "claude-sonnet-4-6"
  reasoningModel: string; // e.g. "claude-opus-4-8"
  newConceptsPerSession: number;
  notificationsEnabled: boolean;
  apiKeyPresent: boolean; // the key itself lives in Keychain, never here
}

// ---- IPC result envelope (so errors are never silently swallowed) ----
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };
