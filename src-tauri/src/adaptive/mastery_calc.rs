//! Mastery scoring & forgetting-curve decay (blocklist 7.1, #9).
//!
//! Mastery is a weighted composite over a ROLLING WINDOW of recent attempts
//! (not a single-attempt EMA):
//!
//! ```text
//! mastery = 0.50 * accuracy + 0.25 * consistency + 0.25 * transfer
//! ```
//!
//! - **accuracy**   — mean correctness over the window.
//! - **consistency**— how stable the recent results are (1 − variance of the
//!   0/1 correctness series; a steady learner scores higher than a streaky one).
//! - **transfer**   — accuracy restricted to `is_transfer = 1` questions. This
//!   term is LIVE: v1 hardcoded `is_transfer = false`, leaving 25% of the score
//!   permanently dead. We tag transfer questions for real and feed their
//!   accuracy here. With no transfer attempts yet, the term falls back to the
//!   overall accuracy so a learner is not penalized before any transfer item.
//!
//! Decay: stored mastery erodes on an exponential forgetting curve keyed to the
//! SM-2 ease factor. The gate uses the DECAY-ADJUSTED `effective_mastery`, never
//! the raw stored score (blocklist 7.3):
//!
//! ```text
//! effective_mastery = mastery * exp(-days_since_review / (k * ease_factor))
//! ```

use rusqlite::{params, Connection};

/// Rolling window: the most recent N graded answers per concept feed mastery.
pub const WINDOW: i64 = 20;
/// Composite weights (must sum to 1.0).
const W_ACCURACY: f64 = 0.50;
const W_CONSISTENCY: f64 = 0.25;
const W_TRANSFER: f64 = 0.25;
/// Decay time constant. Larger ease → slower forgetting (memory is more durable
/// for material the learner finds easy).
pub const DECAY_K: f64 = 14.0;
/// Prerequisite unlock gate: a dependent unlocks only when the prerequisite's
/// decay-adjusted effective mastery is at or above this (blocklist 7.3).
pub const GATE_THRESHOLD: f64 = 0.8;

/// One graded attempt as it feeds the composite (read from `quiz_answers`).
#[derive(Debug, Clone, Copy)]
pub struct Attempt {
    pub is_correct: bool,
    pub is_transfer: bool,
}

/// Compute the composite mastery (0.0–1.0) over a window of attempts. Ordered
/// most-recent-first or oldest-first does not matter (mean/variance are
/// order-independent). An empty window yields 0.0 (no evidence yet).
pub fn composite_mastery(attempts: &[Attempt]) -> f64 {
    if attempts.is_empty() {
        return 0.0;
    }
    let n = attempts.len() as f64;

    let correct = attempts.iter().filter(|a| a.is_correct).count() as f64;
    let accuracy = correct / n;

    // Consistency = 1 − variance of the 0/1 correctness series. For a Bernoulli
    // series the variance is p*(1−p) ∈ [0, 0.25]; scale to [0, 1] so a perfectly
    // steady learner (all right or all wrong) scores 1.0 consistency.
    let variance = accuracy * (1.0 - accuracy);
    let consistency = 1.0 - (variance / 0.25);

    // Transfer accuracy over the transfer subset; fall back to overall accuracy
    // when no transfer attempts exist yet (so the 25% term is never dead-zero
    // purely for lack of transfer data).
    let transfer_attempts: Vec<&Attempt> = attempts.iter().filter(|a| a.is_transfer).collect();
    let transfer = if transfer_attempts.is_empty() {
        accuracy
    } else {
        let tc = transfer_attempts.iter().filter(|a| a.is_correct).count() as f64;
        tc / transfer_attempts.len() as f64
    };

    (W_ACCURACY * accuracy + W_CONSISTENCY * consistency + W_TRANSFER * transfer).clamp(0.0, 1.0)
}

/// Decay-adjusted effective mastery (blocklist 7.3). `days_since_review` is the
/// whole days since the concept was last reviewed; a never-reviewed concept
/// (`None`) is treated as not decayed (its stored mastery stands).
pub fn effective_mastery(mastery: f64, days_since_review: Option<i64>, ease_factor: f64) -> f64 {
    let days = match days_since_review {
        Some(d) if d > 0 => d as f64,
        _ => return mastery.clamp(0.0, 1.0),
    };
    let ease = ease_factor.max(1.0);
    let factor = (-days / (DECAY_K * ease)).exp();
    (mastery * factor).clamp(0.0, 1.0)
}

/// Read the most-recent `WINDOW` attempts for a concept from `quiz_answers`.
pub fn recent_attempts(conn: &Connection, concept_id: &str) -> Result<Vec<Attempt>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT is_correct, is_transfer FROM quiz_answers \
             WHERE concept_id = ?1 ORDER BY id DESC LIMIT ?2",
        )
        .map_err(|e| format!("prepare recent_attempts: {e}"))?;
    let rows = stmt
        .query_map(params![concept_id, WINDOW], |r| {
            Ok(Attempt {
                is_correct: r.get::<_, i64>(0)? != 0,
                is_transfer: r.get::<_, i64>(1)? != 0,
            })
        })
        .map_err(|e| format!("query recent_attempts: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("row: {e}"))?);
    }
    Ok(out)
}

/// Whole days between an ISO date string (`YYYY-MM-DD`) and today (local).
pub fn days_since(last_correct: Option<&str>) -> Option<i64> {
    let s = last_correct?;
    let date = chrono::NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()?;
    let today = chrono::Local::now().date_naive();
    Some((today - date).num_days())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(correct: bool, transfer: bool) -> Attempt {
        Attempt {
            is_correct: correct,
            is_transfer: transfer,
        }
    }

    #[test]
    fn empty_window_is_zero() {
        assert_eq!(composite_mastery(&[]), 0.0);
    }

    #[test]
    fn all_correct_is_full_mastery() {
        let w = vec![a(true, false), a(true, false), a(true, true)];
        // accuracy 1.0, consistency 1.0, transfer 1.0 → 1.0
        assert!((composite_mastery(&w) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn transfer_term_is_live_not_dead() {
        // Same overall accuracy, but failing the transfer items must LOWER the
        // composite — proving the 25% transfer term actually contributes.
        let strong_transfer = vec![
            a(true, true),
            a(true, true),
            a(false, false),
            a(true, false),
        ];
        let weak_transfer = vec![
            a(false, true),
            a(false, true),
            a(true, false),
            a(true, false),
        ];
        assert!(
            composite_mastery(&strong_transfer) > composite_mastery(&weak_transfer),
            "transfer accuracy must move the composite"
        );
    }

    #[test]
    fn decay_reduces_mastery_over_time() {
        let fresh = effective_mastery(0.9, Some(0), 2.5);
        let stale = effective_mastery(0.9, Some(60), 2.5);
        assert!((fresh - 0.9).abs() < 1e-9, "no decay at day 0");
        assert!(stale < fresh, "mastery decays as days pass");
        assert!(stale >= 0.0);
    }

    #[test]
    fn higher_ease_decays_slower() {
        let easy = effective_mastery(0.9, Some(30), 3.0);
        let hard = effective_mastery(0.9, Some(30), 1.5);
        assert!(easy > hard, "durable (high-ease) material decays slower");
    }

    #[test]
    fn never_reviewed_does_not_decay() {
        assert!((effective_mastery(0.7, None, 2.5) - 0.7).abs() < 1e-9);
    }
}
