//! Canonical sample values for each WIRE contract type. Used by the round-trip
//! test: Rust serializes these to a JSON fixture, and a TypeScript test
//! (`src/types/contract.roundtrip.test.ts`) asserts the JSON shape matches the
//! TS interfaces. Keeping the samples here (not in a test module) lets the
//! fixture-writer binary reuse them.
//!
//! Samples are deliberately REALISTIC (populated optionals, mixed correctness)
//! — an unrealistically empty sample hides shape mismatches from the frontend.
//! Only types that actually cross the IPC boundary are sampled; the canonical
//! `Question` (with its answer key) is server-internal and NOT in the fixture —
//! the webview-facing shape is `WireQuestion` (H10).

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
        last_attempt_at: Some("2026-06-11T09:41:12Z".into()),
        state: ConceptState::InProgress,
    }
}

/// The REDACTED question shape the webview receives: prompt + options to
/// render, no `isCorrect`, no `blanks`, no `rubric`, no `explanation`.
pub fn wire_question() -> WireQuestion {
    WireQuestion {
        id: "q1".into(),
        question_type: QuestionType::MultipleChoice,
        prompt: "Which set contains $\\sqrt{2}$?".into(),
        options: Some(vec![
            WireQuizOption {
                id: "a".into(),
                text: "Rationals".into(),
            },
            WireQuizOption {
                id: "b".into(),
                text: "Irrationals".into(),
            },
        ]),
        is_transfer: false,
    }
}

/// What `generate_quiz` returns: the redacted questions plus the quiz-instance
/// nonce (`quizId`) the frontend must hand back to `grade_and_record_quiz`.
pub fn quiz_payload() -> QuizPayload {
    QuizPayload {
        quiz_id: "42".into(),
        questions: vec![wire_question()],
    }
}

pub fn answer_submission() -> AnswerSubmission {
    AnswerSubmission {
        question_id: "q1".into(),
        answer: "b".into(),
        latency_ms: Some(6400),
    }
}

/// The merged grade+record outcome: mixed correctness, populated
/// correctAnswer/feedback per question type, recorded with the refreshed
/// gamification snapshot.
pub fn quiz_outcome() -> QuizOutcome {
    QuizOutcome {
        per_question: vec![
            GradedAnswer {
                question_id: "q1".into(),
                user_answer: "b".into(),
                is_correct: true,
                score: 1.0,
                error_pattern_detected: None,
                correct_answer: Some("Irrationals".into()),
                feedback: Some("The square root of 2 cannot be written as a fraction.".into()),
            },
            GradedAnswer {
                question_id: "q2".into(),
                user_answer: "0.6".into(),
                is_correct: false,
                score: 0.0,
                error_pattern_detected: Some("rounds_instead_of_simplifying".into()),
                correct_answer: Some("1/2 or 0.5".into()),
                feedback: Some("Simplify the fraction before converting.".into()),
            },
            GradedAnswer {
                question_id: "q3".into(),
                user_answer: "Because the decimal never repeats.".into(),
                is_correct: true,
                score: 0.8,
                error_pattern_detected: None,
                correct_answer: None,
                feedback: Some("Good — also mention it never terminates.".into()),
            },
        ],
        final_score: 0.6,
        all_correct: false,
        recorded: true,
        retry_token: None,
        gamification: Some(gamification_state()),
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

pub fn daily_progress() -> DailyProgress {
    DailyProgress {
        minutes_today: 12,
        goal_minutes: 30,
    }
}

pub fn placement_result() -> PlacementResult {
    PlacementResult {
        concept_id: "alg_017".into(),
        domain: "algebra".into(),
        title: "Systems of Linear Equations".into(),
        correct_count: 3,
        total: 5,
    }
}

pub fn app_settings() -> AppSettings {
    AppSettings {
        daily_goal_minutes: 30,
        theme: "system".into(),
        base_model: "claude-sonnet-5".into(),
        reasoning_model: "claude-opus-4-8".into(),
        new_concepts_per_session: 3,
        notifications_enabled: false,
        api_key_present: false,
    }
}

/// Build the full fixture object keyed by contract type name.
pub fn fixture() -> Value {
    serde_json::json!({
        "gamificationState": gamification_state(),
        "concept": concept(),
        "wireQuestion": wire_question(),
        "quizPayload": quiz_payload(),
        "answerSubmission": answer_submission(),
        "quizOutcome": quiz_outcome(),
        "dailySession": daily_session(),
        "dailyProgress": daily_progress(),
        "placementResult": placement_result(),
        "appSettings": app_settings(),
    })
}
