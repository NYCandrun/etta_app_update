//! Canonical sample values for each contract type. Used by the round-trip
//! test: Rust serializes these to a JSON fixture, and a TypeScript test
//! (`src/types/contract.roundtrip.test.ts`) asserts the JSON shape matches the
//! TS interfaces. Keeping the samples here (not in a test module) lets the
//! fixture-writer binary reuse them.

use crate::contract::*;
use serde_json::Value;

pub fn gamification_state() -> GamificationState {
    GamificationState {
        xp: 1234,
        level: LevelInfo {
            level: 5,
            title: "Stargazer".into(),
            xp_into_level: 34,
            xp_for_next_level: 200,
        },
        streak: StreakInfo {
            current_streak: 7,
            longest_streak: 12,
            freezes_available: 2,
            last_active_date: "2026-06-11".into(),
        },
        recent_xp_events: vec![XpEvent {
            amount: 20,
            source: "lesson_complete".into(),
            description: "Completed Real Number System".into(),
            created_at: "2026-06-11T09:30:00Z".into(),
        }],
        badges: vec![Badge {
            id: "first_lesson".into(),
            name: "First Lesson".into(),
            icon_name: "icon-badge-first".into(),
            earned_at: Some("2026-06-10T12:00:00Z".into()),
        }],
    }
}

pub fn concept() -> Concept {
    Concept {
        id: "alg_001".into(),
        domain: "algebra".into(),
        module: "Numbers and Operations".into(),
        title: "Real Number System".into(),
        prerequisites: vec![],
        learning_objectives: vec!["Classify real numbers".into()],
        difficulty_tier: 1,
        error_patterns: vec!["thinks_negative_fractions_are_irrational".into()],
        mastery_score: 0.42,
        effective_mastery: 0.38,
        ease_factor: 2.5,
        interval_days: 6,
        next_review: Some("2026-06-17".into()),
        state: ConceptState::InProgress,
    }
}

pub fn question() -> Question {
    Question {
        id: "q1".into(),
        question_type: QuestionType::MultipleChoice,
        prompt: "Which set contains $\\sqrt{2}$?".into(),
        options: Some(vec![
            QuizOption {
                id: "a".into(),
                text: "Rationals".into(),
                is_correct: false,
            },
            QuizOption {
                id: "b".into(),
                text: "Irrationals".into(),
                is_correct: true,
            },
        ]),
        blanks: None,
        rubric: None,
        explanation: "Square root of 2 is irrational.".into(),
        difficulty: 2,
        is_transfer: false,
    }
}

pub fn quiz_result() -> QuizResult {
    QuizResult {
        concept_id: "alg_001".into(),
        answers: vec![GradedAnswer {
            question_id: "q1".into(),
            user_answer: "b".into(),
            is_correct: true,
            score: 1.0,
            error_pattern_detected: None,
        }],
        final_score: 0.9,
    }
}

pub fn daily_session() -> DailySession {
    DailySession {
        concepts_new: vec!["alg_002".into()],
        concepts_review: vec!["alg_001".into()],
        interleaved_set: vec!["alg_001".into(), "alg_002".into()],
        estimated_minutes: 30,
    }
}

pub fn app_settings() -> AppSettings {
    AppSettings {
        daily_goal_minutes: 30,
        theme: "system".into(),
        base_model: "claude-sonnet-4-6".into(),
        reasoning_model: "claude-opus-4-8".into(),
        new_concepts_per_session: 3,
        notifications_enabled: false,
        api_key_present: false,
    }
}

pub fn ipc_ok() -> IpcResult<AppSettings> {
    IpcResult::Ok {
        data: app_settings(),
    }
}

pub fn ipc_err() -> IpcResult<AppSettings> {
    IpcResult::Err {
        error: "something failed".into(),
    }
}

/// Build the full fixture object keyed by contract type name.
pub fn fixture() -> Value {
    serde_json::json!({
        "gamificationState": gamification_state(),
        "concept": concept(),
        "question": question(),
        "quizResult": quiz_result(),
        "dailySession": daily_session(),
        "appSettings": app_settings(),
        "ipcOk": ipc_ok(),
        "ipcErr": ipc_err(),
    })
}
