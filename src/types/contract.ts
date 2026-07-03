// Shared FE/BE type contract — SINGLE SOURCE OF TRUTH for IPC (Appendix C).
//
// These interfaces mirror the WIRE-facing Rust structs in
// `src-tauri/src/contract.rs` 1:1. Rust serializes with
// `#[serde(rename_all = "camelCase")]`; these camelCase fields must match
// exactly. A round-trip test (`src/types/contract.roundtrip.test.ts`) asserts
// the JSON shape produced by Rust matches these interfaces. Do NOT define
// divergent shapes elsewhere.
//
// NOTE: the canonical server-side Question (which carries the answer key —
// option isCorrect flags, accepted blanks, rubric, explanation) is
// deliberately NOT mirrored here. The webview only ever receives the redacted
// WireQuestion (H10).

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
  lastAttemptAt: string | null; // ISO 8601; most recent quiz attempt (recency)
  state: "completed" | "in_progress" | "unlocked" | "locked";
}

// ---- Quiz (redacted wire shapes; the answer key never leaves the backend) ----
export type QuestionType = "multiple_choice" | "fill_in_blank" | "free_response";
export interface WireQuizOption {
  id: string;
  text: string; // display text only — NO isCorrect on the wire (H10)
}
export interface WireQuestion {
  id: string; // "q1".."q10"
  type: QuestionType;
  prompt: string; // may contain $...$ LaTeX
  options?: WireQuizOption[]; // multiple_choice only
  isTransfer: boolean;
}

// What generateQuiz returns: the redacted questions plus the identity of the
// exact quiz INSTANCE they came from. quizId is an opaque nonce that must be
// passed back to gradeAndRecordQuiz, which grades against exactly that
// instance — a quiz regenerated mid-attempt (other window, model switch)
// reuses ids q1..qN, so without the nonce it could silently displace the
// answered one.
export interface QuizPayload {
  quizId: string;
  questions: WireQuestion[];
}

// One submitted answer: the raw answer plus the per-answer latency (folded in,
// never a separately-indexed array). The frontend NEVER sends a correctness
// flag — grading is server-authoritative.
export interface AnswerSubmission {
  questionId: string;
  answer: string;
  latencyMs: number | null;
}

// One graded answer — produced ONLY server-side; the frontend never sends
// these back (persist retries replay a server-held copy via retryPersist).
export interface GradedAnswer {
  questionId: string;
  userAnswer: string;
  isCorrect: boolean; // computed server-side
  score: number; // 0-1
  errorPatternDetected: string | null;
  // Post-grade review data (safe to reveal AFTER grading):
  correctAnswer: string | null; // MCQ: correct option text; fill-in: accepted blanks joined; free_response: null
  feedback: string | null; // free_response: model feedback; otherwise the canonical explanation
}

// What gradeAndRecordQuiz / retryPersist return. recorded:false means grading
// succeeded but persisting failed — show the score anyway; the graded result
// is held server-side under retryToken and retryPersist(token) re-persists it
// WITHOUT re-grading.
export interface QuizOutcome {
  perQuestion: GradedAnswer[];
  finalScore: number; // over the CANONICAL question count
  allCorrect: boolean;
  recorded: boolean;
  retryToken: string | null; // present exactly when recorded === false
  gamification: GamificationState | null; // refreshed snapshot when recorded
}

// ---- Placement ----
export interface PlacementResult {
  conceptId: string;
  domain: string;
  title: string;
  correctCount: number;
  total: number; // the CANONICAL placement question count
}

// ---- Session ----
export interface DailySession {
  conceptsNew: string[]; // may be >1 (scaled by daily goal)
  conceptsReview: string[];
  interleavedSet: string[]; // MUST be populated (interleaving actually called)
  estimatedMinutes: number;
}

// ---- Daily progress ----
export interface DailyProgress {
  minutesToday: number;
  goalMinutes: number;
}

// ---- Settings ----
export interface AppSettings {
  dailyGoalMinutes: 15 | 30 | 45 | 60;
  theme: "light" | "dark" | "system";
  baseModel: string; // e.g. "claude-sonnet-5"
  reasoningModel: string; // e.g. "claude-opus-4-8"
  newConceptsPerSession: number;
  notificationsEnabled: boolean;
  apiKeyPresent: boolean; // the key itself lives in Keychain, never here
}

// ---- IPC result envelope (CLIENT-side synthesis) ----
//
// This union does NOT exist on the Rust side. Tauri commands return
// Result<T, String>: the promise resolves with T on Ok and rejects with the
// error string on Err. The `call()` wrapper in `src/lib/ipc.ts` catches the
// rejection and synthesizes this envelope so every caller handles the error
// branch explicitly (errors are never silently swallowed).
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };
