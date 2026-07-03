//! Shared FE/BE type contract — SINGLE SOURCE OF TRUTH for IPC (Appendix C).
//!
//! Each struct mirrors a TypeScript interface in `src/types/contract.ts` 1:1.
//! All structs use `#[serde(rename_all = "camelCase")]` so the JSON wire shape
//! matches the TS camelCase fields exactly. A round-trip test serializes a
//! sample of each type to JSON; the TS test asserts the shape matches.
//! Do NOT define divergent IPC shapes anywhere else.

use serde::{Deserialize, Serialize};

// ---- Gamification ----

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GamificationState {
    pub xp: i64,
    pub level: LevelInfo,
    pub streak: StreakInfo,
    pub recent_xp_events: Vec<XpEvent>,
    pub badges: Vec<Badge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LevelInfo {
    pub level: i64,
    pub title: String,
    pub xp_into_level: i64,
    pub xp_for_next_level: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreakInfo {
    pub current_streak: i64,
    pub longest_streak: i64,
    pub freezes_available: i64,
    pub last_active_date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct XpEvent {
    pub amount: i64,
    pub source: String,
    pub description: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Badge {
    pub id: String,
    pub name: String,
    pub icon_name: String,
    pub earned_at: Option<String>,
}

// ---- Concepts & curriculum ----

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConceptState {
    Completed,
    InProgress,
    Unlocked,
    Locked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Concept {
    pub id: String,
    pub domain: String,
    pub module: String,
    pub title: String,
    pub prerequisites: Vec<String>,
    pub learning_objectives: Vec<String>,
    pub difficulty_tier: i64,
    pub error_patterns: Vec<String>,
    pub mastery_score: f64,
    pub effective_mastery: f64,
    pub ease_factor: f64,
    pub interval_days: i64,
    pub next_review: Option<String>,
    /// When the learner last attempted a quiz on this concept (max
    /// `quiz_answers.created_at`, ISO 8601), or None if never attempted.
    /// Drives "Continue where you left off" recency on the dashboard.
    pub last_attempt_at: Option<String>,
    pub state: ConceptState,
}

// ---- Quiz (locked schema; mirrors Appendix A.1/A.3) ----

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuestionType {
    MultipleChoice,
    FillInBlank,
    FreeResponse,
}

/// CANONICAL quiz option — server-side only. Carries the answer key
/// (`is_correct`), so it is cached and graded against but NEVER returned to
/// the webview (H10). The wire shape is `WireQuizOption`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuizOption {
    pub id: String,
    pub text: String,
    pub is_correct: bool,
}

/// CANONICAL question — server-side only (content cache + grading). It embeds
/// the full answer key: `options[].is_correct`, the accepted `blanks`, the
/// free_response `rubric`, and the `explanation`. Commands must NEVER return
/// this to the webview; they return the redacted `WireQuestion` instead (H10).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    #[serde(rename = "type")]
    pub question_type: QuestionType,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<QuizOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blanks: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rubric: Option<String>,
    pub explanation: String,
    pub difficulty: i64,
    pub is_transfer: bool,
}

/// Redacted wire option: id + display text ONLY — no correctness flag.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WireQuizOption {
    pub id: String,
    pub text: String,
}

/// The question shape the webview receives (H10): everything needed to RENDER
/// and ANSWER a question, and nothing that reveals the answer. No `isCorrect`,
/// no `blanks`, no `rubric`, no `explanation` (explanations often spell out the
/// answer; post-grade review gets them via `GradedAnswer.feedback`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WireQuestion {
    pub id: String,
    #[serde(rename = "type")]
    pub question_type: QuestionType,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<WireQuizOption>>,
    pub is_transfer: bool,
}

impl From<&Question> for WireQuestion {
    fn from(q: &Question) -> Self {
        WireQuestion {
            id: q.id.clone(),
            question_type: q.question_type,
            prompt: q.prompt.clone(),
            options: q.options.as_ref().map(|opts| {
                opts.iter()
                    .map(|o| WireQuizOption {
                        id: o.id.clone(),
                        text: o.text.clone(),
                    })
                    .collect()
            }),
            is_transfer: q.is_transfer,
        }
    }
}

/// What `generate_quiz` returns: the redacted questions PLUS the identity of
/// the exact quiz instance they came from (`quiz_id` = the content-cache row
/// id, as an opaque string). The frontend hands `quiz_id` back to
/// `grade_and_record_quiz`, which loads the canonical questions by THAT row —
/// so serve → grade → persist → retry all reference the SAME quiz instance.
/// Without the nonce, a quiz regenerated mid-attempt (second window, model
/// switch) would silently displace the answered one: renumbered q1..qN ids
/// collide across generations, so the permutation gate alone cannot detect
/// the swap.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuizPayload {
    pub quiz_id: String,
    pub questions: Vec<WireQuestion>,
}

/// One submitted answer: the raw answer plus the time the learner took, folded
/// per-answer (no separately-indexed latency array to fall out of alignment).
/// The frontend NEVER sends a correctness flag — grading is server-side.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnswerSubmission {
    pub question_id: String,
    pub answer: String,
    pub latency_ms: Option<i64>,
}

/// One graded answer, produced ONLY server-side. `correct_answer` and
/// `feedback` are populated at grade time (safe post-grading — the wire
/// question itself is redacted, H10):
/// - multiple_choice: `correct_answer` = the correct option's text,
///   `feedback` = the canonical explanation;
/// - fill_in_blank: `correct_answer` = accepted blanks joined with " or ",
///   `feedback` = the canonical explanation;
/// - free_response: `correct_answer` = None (no single canonical answer),
///   `feedback` = the grading model's feedback.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GradedAnswer {
    pub question_id: String,
    pub user_answer: String,
    pub is_correct: bool,
    pub score: f64,
    pub error_pattern_detected: Option<String>,
    pub correct_answer: Option<String>,
    pub feedback: Option<String>,
}

/// What `grade_and_record_quiz` (and `retry_persist`) return: the graded
/// quiz plus whether it was persisted. Replaces the old two-step
/// GradeQuizResult + RecordedQuizResult pair.
///
/// `recorded: false` means grading SUCCEEDED but persisting failed — the UI
/// shows the score anyway and offers a retry. The graded result is held
/// server-side under `retry_token`; `retry_persist(token)` re-persists it
/// WITHOUT re-grading (the frontend never sends graded answers back).
/// `gamification` is the refreshed snapshot, present only when recorded.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuizOutcome {
    pub per_question: Vec<GradedAnswer>,
    pub final_score: f64,
    pub all_correct: bool,
    pub recorded: bool,
    pub retry_token: Option<String>,
    pub gamification: Option<GamificationState>,
}

// ---- Placement ----

/// The placement outcome: the starting concept the learner was placed into and
/// the score that produced it. `total` is the CANONICAL placement question
/// count (never the submitted-answer count).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlacementResult {
    pub concept_id: String,
    pub domain: String,
    pub title: String,
    pub correct_count: i64,
    pub total: i64,
}

// ---- Daily progress ----

/// Today's tracked minutes and the daily goal, so the ring renders a real ratio.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DailyProgress {
    pub minutes_today: i64,
    pub goal_minutes: i64,
}

// ---- Session ----

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DailySession {
    pub concepts_new: Vec<String>,
    pub concepts_review: Vec<String>,
    pub interleaved_set: Vec<String>,
    pub estimated_minutes: i64,
}

// ---- Settings ----

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub daily_goal_minutes: i64,
    pub theme: String,
    pub base_model: String,
    pub reasoning_model: String,
    pub new_concepts_per_session: i64,
    pub notifications_enabled: bool,
    pub api_key_present: bool,
}

// ---- IPC error envelope ----
//
// There is NO Rust-side envelope type. Tauri commands return
// `Result<T, String>`; Tauri resolves the promise with `T` on Ok and rejects
// it with the error string on Err. The `{ ok, data | error }` discriminated
// union the frontend works with is synthesized CLIENT-side by `call()` in
// `src/lib/ipc.ts` — see `IpcResult<T>` in `src/types/contract.ts`.

#[cfg(test)]
mod tests {
    use super::*;

    /// H10: the redacted wire question must never serialize any answer-key
    /// field. Build a canonical question carrying every secret field, convert,
    /// and assert the JSON has none of them (and no explanation, which
    /// typically spells out the answer).
    #[test]
    fn wire_question_serializes_no_answer_key() {
        let canonical = Question {
            id: "q1".into(),
            question_type: QuestionType::MultipleChoice,
            prompt: "Which is irrational?".into(),
            options: Some(vec![
                QuizOption {
                    id: "a".into(),
                    text: "1/2".into(),
                    is_correct: false,
                },
                QuizOption {
                    id: "b".into(),
                    text: "sqrt(2)".into(),
                    is_correct: true,
                },
            ]),
            blanks: Some(vec!["sqrt(2)".into()]),
            rubric: Some("Full credit for citing non-repeating decimals.".into()),
            explanation: "The correct answer is b because sqrt(2) is irrational.".into(),
            difficulty: 2,
            is_transfer: false,
        };

        let wire = WireQuestion::from(&canonical);
        let json = serde_json::to_string(&wire).unwrap();
        for leaked in ["isCorrect", "is_correct", "blanks", "rubric", "explanation"] {
            assert!(
                !json.contains(leaked),
                "redacted wire question must not contain {leaked:?}: {json}"
            );
        }
        // And it still carries everything needed to render + answer.
        assert!(json.contains("\"prompt\""));
        assert!(json.contains("\"options\""));
        assert!(json.contains("\"sqrt(2)\""));
        assert!(json.contains("\"isTransfer\""));

        // The CANONICAL struct keeps the key intact (cache round-trip relies
        // on it — a blanket skip_serializing would corrupt the cache).
        let canonical_json = serde_json::to_string(&canonical).unwrap();
        assert!(canonical_json.contains("isCorrect"));
        assert!(canonical_json.contains("blanks"));
        assert!(canonical_json.contains("rubric"));
    }

    /// Wire questions without options (fill_in_blank / free_response) redact to
    /// prompt-only payloads: no accepted blanks, no rubric on the wire.
    #[test]
    fn wire_question_fill_in_blank_has_no_blanks_key() {
        let canonical = Question {
            id: "q2".into(),
            question_type: QuestionType::FillInBlank,
            prompt: "x + 1 = 2, x = ____".into(),
            options: None,
            blanks: Some(vec!["1".into(), "1.0".into()]),
            rubric: None,
            explanation: "Subtract 1 from both sides.".into(),
            difficulty: 1,
            is_transfer: false,
        };
        let json = serde_json::to_string(&WireQuestion::from(&canonical)).unwrap();
        assert!(!json.contains("blanks"), "no answer key on the wire: {json}");
        assert!(!json.contains("options"), "None options are omitted entirely");
    }
}
