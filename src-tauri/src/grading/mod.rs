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

/// The canonical explanation as post-grade feedback (None when empty). Safe to
/// reveal AFTER grading — the wire question is redacted precisely so this text
/// (which typically spells out the answer) is never seen pre-grade (H10).
fn explanation_feedback(question: &Question) -> Option<String> {
    let e = question.explanation.trim();
    (!e.is_empty()).then(|| e.to_string())
}

fn grade_multiple_choice(question: &Question, user_answer: &str) -> GradedAnswer {
    // Correctness is derived from the canonical options[].isCorrect — the FE's
    // claim about which option is right is irrelevant here.
    let correct_option = question
        .options
        .as_ref()
        .and_then(|opts| opts.iter().find(|o| o.is_correct));

    let is_correct = correct_option
        .is_some_and(|o| o.id.eq_ignore_ascii_case(user_answer.trim()));

    GradedAnswer {
        question_id: question.id.clone(),
        user_answer: user_answer.to_string(),
        is_correct,
        score: if is_correct { 1.0 } else { 0.0 },
        error_pattern_detected: None,
        // The correct option's TEXT (not its id — the review screen shows the
        // human-readable answer).
        correct_answer: correct_option.map(|o| o.text.clone()),
        feedback: explanation_feedback(question),
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
        // All accepted blanks, human-readable.
        correct_answer: question
            .blanks
            .as_ref()
            .filter(|b| !b.is_empty())
            .map(|b| b.join(" or ")),
        feedback: explanation_feedback(question),
    }
}

/// Package a model-produced free_response grade into a GradedAnswer. `score`
/// is clamped; `is_correct` is true at or above the pass threshold. The
/// model's `feedback` is KEPT (it used to be discarded) — free_response has no
/// single canonical answer, so feedback is the review surface.
pub fn grade_free_response_from_score(
    question: &Question,
    user_answer: &str,
    score: f64,
    feedback: String,
    error_pattern_detected: Option<String>,
) -> GradedAnswer {
    let score = score.clamp(0.0, 1.0);
    let feedback = feedback.trim().to_string();
    GradedAnswer {
        question_id: question.id.clone(),
        user_answer: user_answer.to_string(),
        is_correct: score >= 0.7,
        score,
        error_pattern_detected,
        correct_answer: None,
        feedback: (!feedback.is_empty()).then_some(feedback),
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
            explanation: "Because y.".into(),
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
            blanks: Some(vec!["1/2".into(), "0.5".into()]),
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

    /// multiple_choice populates the correct option's TEXT (not id) as
    /// correct_answer and the canonical explanation as feedback — for wrong
    /// AND right answers (the review screen shows both).
    #[test]
    fn mc_populates_correct_answer_text_and_feedback() {
        let wrong = grade_objective(&mc(), "a").unwrap();
        assert_eq!(wrong.correct_answer.as_deref(), Some("y"));
        assert_eq!(wrong.feedback.as_deref(), Some("Because y."));
        let right = grade_objective(&mc(), "b").unwrap();
        assert_eq!(right.correct_answer.as_deref(), Some("y"));
    }

    /// fill_in_blank joins the accepted blanks; an empty explanation yields
    /// feedback = None (never Some("")).
    #[test]
    fn fill_in_blank_populates_joined_blanks() {
        let g = grade_objective(&fib(), "7").unwrap();
        assert!(!g.is_correct);
        assert_eq!(g.correct_answer.as_deref(), Some("1/2 or 0.5"));
        assert_eq!(g.feedback, None, "empty explanation must not become Some(\"\")");
    }

    /// free_response keeps the model's feedback (previously discarded) and has
    /// no single canonical answer.
    #[test]
    fn free_response_keeps_model_feedback() {
        let mut q = fib();
        q.question_type = QuestionType::FreeResponse;
        let g = grade_free_response_from_score(
            &q,
            "my essay",
            0.8,
            "Good reasoning; cite the definition next time.".into(),
            Some("skips_justification".into()),
        );
        assert!(g.is_correct);
        assert_eq!(g.correct_answer, None);
        assert_eq!(
            g.feedback.as_deref(),
            Some("Good reasoning; cite the definition next time.")
        );
        // Blank model feedback stays None.
        let g = grade_free_response_from_score(&q, "x", 0.2, "   ".into(), None);
        assert_eq!(g.feedback, None);
    }
}
