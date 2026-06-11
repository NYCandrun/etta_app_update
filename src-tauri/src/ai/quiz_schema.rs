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

/// Parse and validate a model's quiz output (a JSON array). Returns the repaired
/// list of `Question`s, or an error describing the first unrepairable problem.
/// A `short_answer` type is coerced to `free_response`; truly unknown types are
/// rejected with a clear error (NOT auto-zeroed).
pub fn parse_and_repair(raw: &str) -> Result<Vec<Question>, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| format!("quiz output is not valid JSON: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| "quiz output must be a JSON array".to_string())?;

    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        out.push(repair_one(item).map_err(|e| format!("question[{i}]: {e}"))?);
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
          {"id":"q1","type":"short_answer","prompt":"Define a limit.",
           "explanation":"...","difficulty":2,"is_transfer":false}
        ]"#;
        let qs = parse_and_repair(raw).expect("should repair, not fail");
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0].question_type, QuestionType::FreeResponse);
        assert!(qs[0].rubric.is_some(), "synthesized rubric for grading");
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
