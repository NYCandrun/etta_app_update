//! Input validation for Tauri commands (blocklist #44). Length limits on
//! strings, numeric range checks, and concept-id format checks. Invalid input
//! is rejected with a typed (String) error before it touches the DB.

/// Max length for free-form string inputs accepted by commands (e.g. content
/// payloads are validated separately; this guards ids/short fields).
pub const MAX_ID_LEN: usize = 32;

/// Concept ids match `^[a-z]{2,4}_[0-9]{3}$` (e.g. `alg_001`, `astr_142`).
/// Implemented without the `regex` crate to avoid a dependency.
pub fn is_valid_concept_id(id: &str) -> bool {
    if id.len() > MAX_ID_LEN {
        return false;
    }
    let Some((prefix, digits)) = id.split_once('_') else {
        return false;
    };
    let prefix_ok =
        (2..=4).contains(&prefix.len()) && prefix.bytes().all(|b| b.is_ascii_lowercase());
    let digits_ok = digits.len() == 3 && digits.bytes().all(|b| b.is_ascii_digit());
    prefix_ok && digits_ok
}

/// Reject an invalid concept id with a typed error.
pub fn concept_id(id: &str) -> Result<(), String> {
    if is_valid_concept_id(id) {
        Ok(())
    } else {
        Err(format!("invalid concept id: {id:?}"))
    }
}

/// Bound a free-form string by length. `field` names the offending input in the
/// error (never logs secret content).
pub fn string_len(field: &str, s: &str, max: usize) -> Result<(), String> {
    if s.len() > max {
        Err(format!("{field} exceeds max length {max}"))
    } else {
        Ok(())
    }
}

/// Inclusive numeric range check.
pub fn in_range_i64(field: &str, n: i64, lo: i64, hi: i64) -> Result<(), String> {
    if (lo..=hi).contains(&n) {
        Ok(())
    } else {
        Err(format!("{field} must be in {lo}..={hi}"))
    }
}

/// Max accepted length (bytes) for one submitted quiz/placement answer —
/// matches the 4000-char cap the lesson `user_input` edge already enforces.
pub const MAX_ANSWER_LEN: usize = 4000;

/// Latency upper bound per answer: 10 minutes. Anything beyond that is a
/// client bug or forgery, not a measurement.
pub const MAX_LATENCY_MS: i64 = 600_000;

/// Bound one submitted answer's free-form text (R4). Friendly reject BEFORE
/// any DB write or model call — an unbounded paste would otherwise be embedded
/// into a grading prompt and persisted verbatim.
pub fn answer_text(answer: &str) -> Result<(), String> {
    if answer.len() > MAX_ANSWER_LEN {
        Err(format!(
            "that answer is too long — please shorten it to under {MAX_ANSWER_LEN} characters"
        ))
    } else {
        Ok(())
    }
}

/// Bound a submitted answer latency (R4): None is fine (untracked), otherwise
/// 0..=600000 ms. The `quiz_answers.latency_ms` CHECK constraint would reject
/// a negative value anyway, but as a raw internal error — this is the friendly
/// command-edge version, and it also stops absurd values from skewing SM-2.
pub fn latency_ms(latency: Option<i64>) -> Result<(), String> {
    match latency {
        None => Ok(()),
        Some(ms) if (0..=MAX_LATENCY_MS).contains(&ms) => Ok(()),
        Some(_) => Err(
            "that answer's timing looks invalid — please try submitting the quiz again".to_string(),
        ),
    }
}

/// Allowed content-cache content types (mirrors the schema CHECK constraint).
/// `lesson_reinforced` is the personalized-lesson key (C3) — plain lessons and
/// reinforced ones cache independently.
pub fn content_type(ct: &str) -> Result<(), String> {
    match ct {
        "lesson" | "lesson_reinforced" | "quiz" | "explain" | "review" => Ok(()),
        other => Err(format!("invalid content_type: {other:?}")),
    }
}

/// H9/H15: submitted answers must be an EXACT PERMUTATION of the canonical
/// question ids — every canonical question answered exactly once, and nothing
/// else. Rejects duplicates (score inflation), omissions (cherry-picking) and
/// unknown ids with friendly errors. Shared by `grade_and_record_quiz` and
/// `place_learner`.
pub fn answer_permutation(
    canonical_ids: &[&str],
    submitted_ids: impl IntoIterator<Item = impl AsRef<str>>,
) -> Result<(), String> {
    use std::collections::HashSet;
    let canonical: HashSet<&str> = canonical_ids.iter().copied().collect();
    let mut seen: HashSet<String> = HashSet::new();
    for id in submitted_ids {
        let id = id.as_ref();
        if !canonical.contains(id) {
            return Err(format!("answer references unknown question {id:?}"));
        }
        if !seen.insert(id.to_string()) {
            return Err(format!(
                "question {id:?} was answered more than once — please submit each question exactly once"
            ));
        }
    }
    if seen.len() != canonical.len() {
        return Err(format!(
            "please answer every question before submitting ({} of {} answered)",
            seen.len(),
            canonical.len()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concept_id_regex() {
        assert!(is_valid_concept_id("alg_001"));
        assert!(is_valid_concept_id("astr_142"));
        assert!(is_valid_concept_id("ab_999"));
        // Wrong digit count
        assert!(!is_valid_concept_id("alg_01"));
        assert!(!is_valid_concept_id("alg_0001"));
        // Wrong prefix
        assert!(!is_valid_concept_id("a_001"));
        assert!(!is_valid_concept_id("abcde_001"));
        assert!(!is_valid_concept_id("Alg_001"));
        // Missing separator / junk
        assert!(!is_valid_concept_id("alg001"));
        assert!(!is_valid_concept_id(""));
        assert!(!is_valid_concept_id("alg_001; DROP TABLE concepts"));
    }

    /// H9/H15 permutation gate: exact set accepted; duplicate, missing, and
    /// unknown ids each rejected with a distinct friendly error.
    #[test]
    fn answer_permutation_enforces_exact_set() {
        let canonical = ["q1", "q2", "q3"];

        // Exact permutation (any order) accepted.
        assert!(answer_permutation(&canonical, ["q3", "q1", "q2"]).is_ok());

        // Duplicate id rejected — 5 copies of one correct answer must not grade.
        let err = answer_permutation(&canonical, ["q1", "q1", "q2", "q3"]).unwrap_err();
        assert!(err.contains("more than once"), "dup error: {err}");

        // Missing id rejected — cherry-picking a subset must not grade.
        let err = answer_permutation(&canonical, ["q1", "q2"]).unwrap_err();
        assert!(err.contains("answer every question"), "missing error: {err}");

        // Unknown id rejected (keeps the existing unknown-question style).
        let err = answer_permutation(&canonical, ["q1", "q2", "nope"]).unwrap_err();
        assert!(err.contains("unknown question"), "unknown error: {err}");

        // Duplicates cannot mask an omission: 3 answers, only 2 distinct.
        let err = answer_permutation(&canonical, ["q1", "q2", "q2"]).unwrap_err();
        assert!(err.contains("more than once"), "dup-masking error: {err}");
    }

    /// R4: answer text is bounded with a friendly message; the boundary value
    /// passes.
    #[test]
    fn answer_text_bounded_with_friendly_error() {
        assert!(answer_text("x = 3").is_ok());
        assert!(answer_text(&"a".repeat(MAX_ANSWER_LEN)).is_ok(), "boundary passes");
        let err = answer_text(&"a".repeat(MAX_ANSWER_LEN + 1)).unwrap_err();
        assert!(err.contains("too long"), "friendly: {err}");
        assert!(!err.contains("exceeds max length"), "not the internal phrasing");
    }

    /// R4: latency is None-or-0..=600000; out-of-range values get a friendly
    /// reject instead of the raw DB CHECK-constraint error.
    #[test]
    fn latency_ms_bounded_with_friendly_error() {
        assert!(latency_ms(None).is_ok());
        assert!(latency_ms(Some(0)).is_ok());
        assert!(latency_ms(Some(MAX_LATENCY_MS)).is_ok(), "boundary passes");
        for bad in [-1_i64, MAX_LATENCY_MS + 1, i64::MIN, i64::MAX] {
            let err = latency_ms(Some(bad)).unwrap_err();
            assert!(err.contains("timing"), "friendly for {bad}: {err}");
            assert!(!err.to_lowercase().contains("check"), "no raw constraint talk");
        }
    }
}
