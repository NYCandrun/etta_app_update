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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuizOption {
    pub id: String,
    pub text: String,
    pub is_correct: bool,
}

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GradedAnswer {
    pub question_id: String,
    pub user_answer: String,
    pub is_correct: bool,
    pub score: f64,
    pub error_pattern_detected: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuizResult {
    pub concept_id: String,
    pub answers: Vec<GradedAnswer>,
    pub final_score: f64,
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

// ---- IPC result envelope ----
//
// On the wire this is `{ ok: true, data: T } | { ok: false, error: String }`,
// matching `IpcResult<T>` in TS. Tauri commands return `Result<T, String>`
// and a thin wrapper maps it to this envelope so the frontend always sees an
// explicit ok/error branch (errors are never silently swallowed).
//
// `ok` is a real JSON boolean, so we implement (de)serialization by hand
// rather than via serde's string-only internal tag.

#[derive(Debug, Clone, PartialEq)]
pub enum IpcResult<T> {
    Ok { data: T },
    Err { error: String },
}

impl<T> From<Result<T, String>> for IpcResult<T> {
    fn from(r: Result<T, String>) -> Self {
        match r {
            Ok(data) => IpcResult::Ok { data },
            Err(error) => IpcResult::Err { error },
        }
    }
}

impl<T: Serialize> Serialize for IpcResult<T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            IpcResult::Ok { data } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("ok", &true)?;
                map.serialize_entry("data", data)?;
                map.end()
            }
            IpcResult::Err { error } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("ok", &false)?;
                map.serialize_entry("error", error)?;
                map.end()
            }
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for IpcResult<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw<T> {
            ok: bool,
            data: Option<T>,
            error: Option<String>,
        }
        let raw = Raw::<T>::deserialize(deserializer)?;
        if raw.ok {
            let data = raw
                .data
                .ok_or_else(|| serde::de::Error::missing_field("data"))?;
            Ok(IpcResult::Ok { data })
        } else {
            let error = raw
                .error
                .ok_or_else(|| serde::de::Error::missing_field("error"))?;
            Ok(IpcResult::Err { error })
        }
    }
}
