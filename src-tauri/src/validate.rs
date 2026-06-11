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

/// Allowed content-cache content types (mirrors the schema CHECK constraint).
pub fn content_type(ct: &str) -> Result<(), String> {
    match ct {
        "lesson" | "quiz" | "explain" | "review" => Ok(()),
        other => Err(format!("invalid content_type: {other:?}")),
    }
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
}
