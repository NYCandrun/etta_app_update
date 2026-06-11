//! Server-authoritative grading (blocklist #0a, #10, #11).
//!
//! Correctness is computed in Rust from the canonical question JSON — NEVER
//! trusted from a frontend-supplied flag (the FE sends only the raw answer;
//! M3 wires that). v1's corrupted cache made grading silently fall back to
//! trusting the frontend; now the data layer parses real JSON and grading uses
//! the typed `Question`.
//!
//! - multiple_choice: the correct option is the one with `isCorrect == true` in
//!   the canonical question; we match the learner's chosen option id against it.
//! - fill_in_blank: graded by MATHEMATICAL EQUIVALENCE (see `math_eq`), not a
//!   case-insensitive string compare.
//! - free_response: graded by the model against the rubric (see
//!   `client::grade_free_response`); this module exposes the deterministic part
//!   and a helper to package the model's structured score.

pub mod math_eq;

use crate::contract::{GradedAnswer, Question, QuestionType};

/// Grade a multiple_choice or fill_in_blank answer deterministically in Rust.
/// Returns `None` for free_response (which requires a model call) so the caller
/// routes it to the async grader.
pub fn grade_objective(question: &Question, user_answer: &str) -> Option<GradedAnswer> {
    match question.question_type {
        QuestionType::MultipleChoice => Some(grade_multiple_choice(question, user_answer)),
        QuestionType::FillInBlank => Some(grade_fill_in_blank(question, user_answer)),
        QuestionType::FreeResponse => None,
    }
}

fn grade_multiple_choice(question: &Question, user_answer: &str) -> GradedAnswer {
    // Correctness is derived from the canonical options[].isCorrect — the FE's
    // claim about which option is right is irrelevant here.
    let correct_id = question
        .options
        .as_ref()
        .and_then(|opts| opts.iter().find(|o| o.is_correct))
        .map(|o| o.id.as_str());

    let is_correct = correct_id.is_some_and(|cid| cid.eq_ignore_ascii_case(user_answer.trim()));

    GradedAnswer {
        question_id: question.id.clone(),
        user_answer: user_answer.to_string(),
        is_correct,
        score: if is_correct { 1.0 } else { 0.0 },
        error_pattern_detected: None,
    }
}

fn grade_fill_in_blank(question: &Question, user_answer: &str) -> GradedAnswer {
    // Any accepted blank that is mathematically equivalent to the answer counts.
    let is_correct = question
        .blanks
        .as_ref()
        .is_some_and(|blanks| blanks.iter().any(|b| math_eq::equivalent(b, user_answer)));

    GradedAnswer {
        question_id: question.id.clone(),
        user_answer: user_answer.to_string(),
        is_correct,
        score: if is_correct { 1.0 } else { 0.0 },
        error_pattern_detected: None,
    }
}

/// Package a model-produced free_response score (0.0–1.0) into a GradedAnswer.
/// `score` is clamped; `is_correct` is true at or above the pass threshold.
pub fn grade_free_response_from_score(
    question: &Question,
    user_answer: &str,
    score: f64,
    error_pattern_detected: Option<String>,
) -> GradedAnswer {
    let score = score.clamp(0.0, 1.0);
    GradedAnswer {
        question_id: question.id.clone(),
        user_answer: user_answer.to_string(),
        is_correct: score >= 0.7,
        score,
        error_pattern_detected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::QuizOption;

    fn mc() -> Question {
        Question {
            id: "q1".into(),
            question_type: QuestionType::MultipleChoice,
            prompt: "p".into(),
            options: Some(vec![
                QuizOption {
                    id: "a".into(),
                    text: "x".into(),
                    is_correct: false,
                },
                QuizOption {
                    id: "b".into(),
                    text: "y".into(),
                    is_correct: true,
                },
            ]),
            blanks: None,
            rubric: None,
            explanation: String::new(),
            difficulty: 1,
            is_transfer: false,
        }
    }

    fn fib() -> Question {
        Question {
            id: "q2".into(),
            question_type: QuestionType::FillInBlank,
            prompt: "x = ____".into(),
            options: None,
            blanks: Some(vec!["1/2".into()]),
            rubric: None,
            explanation: String::new(),
            difficulty: 1,
            is_transfer: false,
        }
    }

    #[test]
    fn mc_correctness_from_canonical_not_frontend() {
        let g = grade_objective(&mc(), "b").unwrap();
        assert!(g.is_correct && g.score == 1.0);
        let g = grade_objective(&mc(), "a").unwrap();
        assert!(!g.is_correct && g.score == 0.0);
    }

    #[test]
    fn fill_in_blank_uses_math_equivalence() {
        // "0.5" is equivalent to the accepted "1/2" — must be correct.
        let g = grade_objective(&fib(), "0.5").unwrap();
        assert!(g.is_correct, "0.5 should equal 1/2");
    }

    #[test]
    fn free_response_routes_to_async() {
        let mut q = fib();
        q.question_type = QuestionType::FreeResponse;
        assert!(grade_objective(&q, "anything").is_none());
    }
}
