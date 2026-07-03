//! Locked quiz JSON schema validation & repair (Appendix A.3, blocklist #10).
//!
//! The AI emits a JSON array of question objects. The grader accepts EXACTLY
//! three `type` values: multiple_choice, fill_in_blank, free_response. Anything
//! else is REPAIRED where there is an obvious mapping (e.g. a stray
//! `short_answer` → `free_response`, since both are free-text graded) or
//! REJECTED — it is NEVER auto-zeroed (auto-zeroing silently penalizes the
//! learner for the model's formatting slip; v1 did this).
//!
//! Validation parses real JSON into the shared `Question` contract type, so
//! grading later operates on a typed, schema-correct value (never trusting a
//! frontend-supplied flag).

use serde_json::Value;

use crate::contract::{Question, QuestionType, QuizOption};

/// The smallest quiz worth presenting or caching. An empty (or near-empty)
/// array parses as valid JSON, and v1 happily cached `[]` and served a blank
/// quiz page for 7 days (H21) — so degenerate counts are a VALIDATION error.
pub const MIN_QUESTIONS: usize = 3;

/// Parse and validate a model's quiz output (a JSON array). Returns the repaired
/// list of `Question`s, or an error describing the first unrepairable problem.
/// A `short_answer` type is coerced to `free_response`; truly unknown types are
/// rejected with a clear error (NOT auto-zeroed). Quizzes with fewer than
/// `MIN_QUESTIONS` questions are rejected outright — callers cache only Ok
/// values, so a degenerate quiz can never poison the cache (H21).
///
/// DUPLICATE QUESTION IDS ARE REJECTED here (belt): a duplicate-id quiz breaks
/// the exact-permutation gate's denominator, making an honest full submission
/// unsubmittable for the cache's whole life. The GENERATION paths avoid ever
/// hitting this by re-numbering fresh model output (`parse_and_renumber`); this
/// strict check covers every OTHER consumer (cache re-validation, grading).
pub fn parse_and_repair(raw: &str) -> Result<Vec<Question>, String> {
    let out = parse_questions(raw)?;
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for q in &out {
        if !seen.insert(q.id.as_str()) {
            return Err(format!("duplicate question id {:?}", q.id));
        }
    }
    Ok(out)
}

/// Parse fresh MODEL output for the generation paths: same validation/repair,
/// then the ids are deterministically re-numbered q1..qN (the same pattern
/// placement uses) — so duplicate or odd model-emitted ids are NORMALIZED
/// rather than rejected, and cache/wire/grading always agree on q1..qN.
pub fn parse_and_renumber(raw: &str) -> Result<Vec<Question>, String> {
    let mut out = parse_questions(raw)?;
    renumber_ids(&mut out);
    Ok(out)
}

/// Deterministic canonical ids: q1..qN in array order.
pub fn renumber_ids(questions: &mut [Question]) {
    for (i, q) in questions.iter_mut().enumerate() {
        q.id = format!("q{}", i + 1);
    }
}

/// Shared parse core (no id-uniqueness policy — see the two public wrappers).
/// Tolerates a markdown code fence around the JSON array, exactly like
/// `parse_free_response_grade` does (models drift into fencing either output).
fn parse_questions(raw: &str) -> Result<Vec<Question>, String> {
    let trimmed = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let value: Value =
        serde_json::from_str(trimmed).map_err(|e| format!("quiz output is not valid JSON: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| "quiz output must be a JSON array".to_string())?;

    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        out.push(repair_one(item).map_err(|e| format!("question[{i}]: {e}"))?);
    }
    if out.len() < MIN_QUESTIONS {
        return Err(format!(
            "quiz has too few questions ({} < {MIN_QUESTIONS})",
            out.len()
        ));
    }
    Ok(out)
}

/// Repair/validate a single question object.
fn repair_one(item: &Value) -> Result<Question, String> {
    let obj = item.as_object().ok_or("not a JSON object")?;

    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .ok_or("missing string id")?
        .to_string();

    let raw_type = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or("missing string type")?;

    // Repair known aliases; reject genuinely unknown types (never auto-zero).
    let question_type = match raw_type {
        "multiple_choice" => QuestionType::MultipleChoice,
        "fill_in_blank" => QuestionType::FillInBlank,
        "free_response" => QuestionType::FreeResponse,
        // Common model drift: short_answer / open_ended are free-text graded.
        "short_answer" | "open_ended" | "essay" => {
            tracing::warn!(raw_type, "coercing unknown quiz type to free_response");
            QuestionType::FreeResponse
        }
        other => return Err(format!("unsupported question type {other:?}")),
    };

    let prompt = obj
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or("missing string prompt")?
        .to_string();

    let explanation = obj
        .get("explanation")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let difficulty = obj
        .get("difficulty")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 5);

    // Accept both is_transfer (model/system-prompt shape) and isTransfer (contract).
    let is_transfer = obj
        .get("is_transfer")
        .or_else(|| obj.get("isTransfer"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let (options, blanks, rubric) = match question_type {
        QuestionType::MultipleChoice => {
            let opts = parse_options(obj.get("options"))?;
            (Some(opts), None, None)
        }
        QuestionType::FillInBlank => {
            let blanks = obj
                .get("blanks")
                .and_then(Value::as_array)
                .ok_or("fill_in_blank missing blanks array")?
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>();
            if blanks.is_empty() {
                return Err("fill_in_blank has no acceptable answers".into());
            }
            (None, Some(blanks), None)
        }
        QuestionType::FreeResponse => {
            // A rubric is required for grading; if the model omitted it (e.g. on a
            // coerced short_answer), synthesize a minimal one rather than reject.
            let rubric = obj
                .get("rubric")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| "Grade for correctness and completeness.".to_string());
            (None, None, Some(rubric))
        }
    };

    Ok(Question {
        id,
        question_type,
        prompt,
        options,
        blanks,
        rubric,
        explanation,
        difficulty,
        is_transfer,
    })
}

fn parse_options(v: Option<&Value>) -> Result<Vec<QuizOption>, String> {
    let arr = v
        .and_then(Value::as_array)
        .ok_or("multiple_choice missing options array")?;
    let mut out = Vec::with_capacity(arr.len());
    for o in arr {
        let obj = o.as_object().ok_or("option is not an object")?;
        out.push(QuizOption {
            id: obj
                .get("id")
                .and_then(Value::as_str)
                .ok_or("option missing id")?
                .to_string(),
            text: obj
                .get("text")
                .and_then(Value::as_str)
                .ok_or("option missing text")?
                .to_string(),
            is_correct: obj
                .get("isCorrect")
                .or_else(|| obj.get("is_correct"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    let correct = out.iter().filter(|o| o.is_correct).count();
    if correct != 1 {
        return Err(format!(
            "multiple_choice must have exactly one correct option (found {correct})"
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `short_answer` type is coerced to free_response — never auto-zeroed or
    /// rejected (Appendix A.3 / required test).
    #[test]
    fn short_answer_is_repaired_to_free_response() {
        let raw = r#"[
          {"id":"q1","type":"free_response","prompt":"a","rubric":"r",
           "explanation":"","difficulty":1,"is_transfer":false},
          {"id":"q2","type":"short_answer","prompt":"Define a limit.",
           "explanation":"...","difficulty":2,"is_transfer":false},
          {"id":"q3","type":"free_response","prompt":"c","rubric":"r",
           "explanation":"","difficulty":1,"is_transfer":false}
        ]"#;
        let qs = parse_and_repair(raw).expect("should repair, not fail");
        assert_eq!(qs.len(), 3);
        assert_eq!(qs[1].question_type, QuestionType::FreeResponse);
        assert!(qs[1].rubric.is_some(), "synthesized rubric for grading");
    }

    /// H21: an empty array is VALID JSON but a degenerate quiz — it must be
    /// rejected (v1 cached `[]` and served a blank quiz page for 7 days). The
    /// same applies to any count below the minimum; the minimum itself passes.
    #[test]
    fn empty_or_too_small_quiz_is_rejected() {
        let err = parse_and_repair("[]").unwrap_err();
        assert!(err.contains("too few questions"), "got: {err}");

        let two = r#"[
          {"id":"q1","type":"free_response","prompt":"a","rubric":"r",
           "explanation":"","difficulty":1},
          {"id":"q2","type":"free_response","prompt":"b","rubric":"r",
           "explanation":"","difficulty":1}
        ]"#;
        assert!(parse_and_repair(two).is_err(), "2 < MIN_QUESTIONS");

        let three = r#"[
          {"id":"q1","type":"free_response","prompt":"a","rubric":"r",
           "explanation":"","difficulty":1},
          {"id":"q2","type":"free_response","prompt":"b","rubric":"r",
           "explanation":"","difficulty":1},
          {"id":"q3","type":"free_response","prompt":"c","rubric":"r",
           "explanation":"","difficulty":1}
        ]"#;
        assert_eq!(parse_and_repair(three).unwrap().len(), MIN_QUESTIONS);
    }

    /// R2: duplicate model-emitted question ids. The strict parse (cache
    /// re-validation, grading) REJECTS them; the generation parse NORMALIZES
    /// them to q1..qN, and the permutation gate then accepts an honest full
    /// submission of the served quiz.
    #[test]
    fn duplicate_ids_rejected_strictly_but_renumbered_for_generation() {
        let dup = r#"[
          {"id":"q1","type":"free_response","prompt":"a","rubric":"r",
           "explanation":"","difficulty":1},
          {"id":"q2","type":"free_response","prompt":"b","rubric":"r",
           "explanation":"","difficulty":1},
          {"id":"q2","type":"free_response","prompt":"c","rubric":"r",
           "explanation":"","difficulty":1}
        ]"#;

        let err = parse_and_repair(dup).unwrap_err();
        assert!(err.contains("duplicate question id"), "got: {err}");

        let qs = parse_and_renumber(dup).expect("generation path normalizes");
        let ids: Vec<&str> = qs.iter().map(|q| q.id.as_str()).collect();
        assert_eq!(ids, ["q1", "q2", "q3"], "unique sequential ids");
        // The served quiz is gradable: a full submission passes the H9/H15
        // exact-permutation gate.
        assert!(crate::validate::answer_permutation(&ids, ["q3", "q1", "q2"]).is_ok());
        // And the normalized payload re-passes the STRICT parse (what the
        // cache-hit and grading paths run).
        let payload = serde_json::to_string(&qs).unwrap();
        assert!(parse_and_repair(&payload).is_ok());
    }

    /// R10: a markdown-fenced JSON array parses (same tolerance as
    /// `parse_free_response_grade`) — with and without the `json` language tag.
    #[test]
    fn markdown_fenced_json_is_tolerated() {
        let inner = r#"[
          {"id":"q1","type":"free_response","prompt":"a","rubric":"r",
           "explanation":"","difficulty":1},
          {"id":"q2","type":"free_response","prompt":"b","rubric":"r",
           "explanation":"","difficulty":1},
          {"id":"q3","type":"free_response","prompt":"c","rubric":"r",
           "explanation":"","difficulty":1}
        ]"#;
        let fenced_json = format!("```json\n{inner}\n```");
        assert_eq!(parse_and_repair(&fenced_json).unwrap().len(), 3);
        let fenced_bare = format!("```\n{inner}\n```");
        assert_eq!(parse_and_repair(&fenced_bare).unwrap().len(), 3);
        assert_eq!(parse_and_renumber(&fenced_json).unwrap().len(), 3);
    }

    /// A genuinely unknown type is rejected with an error — NOT auto-zeroed.
    #[test]
    fn unknown_type_is_rejected_not_zeroed() {
        let raw = r#"[
          {"id":"q1","type":"matching","prompt":"x","explanation":"","difficulty":1}
        ]"#;
        let err = parse_and_repair(raw).unwrap_err();
        assert!(err.contains("unsupported question type"), "got: {err}");
    }

    #[test]
    fn multiple_choice_requires_exactly_one_correct() {
        let two_correct = r#"[
          {"id":"q1","type":"multiple_choice","prompt":"p","explanation":"",
           "difficulty":1,"options":[
             {"id":"a","text":"x","isCorrect":true},
             {"id":"b","text":"y","isCorrect":true}]}
        ]"#;
        assert!(parse_and_repair(two_correct).is_err());
    }
}
