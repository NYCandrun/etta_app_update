//! Session builder & prerequisite gating (blocklist 7.3, 7.5, #0c).
//!
//! The session builder:
//! - schedules MULTIPLE new concepts per session, scaled by the daily goal and
//!   the `new_concepts_per_session` setting (v1 hard-capped exactly one);
//! - CAPS the total session size so a high goal cannot produce an unbounded
//!   queue;
//! - ACTUALLY CALLS the interleaving function (v1 defined `generate_interleaved
//!   _set` but never invoked it) to weave new + recent + due-review concepts;
//! - prioritizes reviews by decay level and relationship to today's new concept,
//!   not merely "most overdue first".
//!
//! Gating uses the DECAY-ADJUSTED effective mastery (blocklist 7.3): a dependent
//! unlocks only when EVERY prerequisite's `effective_mastery >= GATE_THRESHOLD`.
//! All reads here are pure (no writes — blocklist #0c).

use rusqlite::Connection;

use super::mastery_calc::{days_since, effective_mastery, GATE_THRESHOLD};
use super::sm2::{FORCE_REVIEW_DAYS, REENTRY_MASTERY};
use crate::contract::{ConceptState, DailySession};

/// Per-concept row needed for gating and session building.
#[derive(Debug, Clone)]
pub struct ConceptStateRow {
    pub id: String,
    pub domain: String,
    pub difficulty_tier: i64,
    pub prerequisites: Vec<String>,
    pub mastery_score: f64,
    pub ease_factor: f64,
    pub interval_days: i64,
    pub next_review: Option<String>,
    pub last_correct: Option<String>,
    pub attempt_count: i64,
}

impl ConceptStateRow {
    /// Decay-adjusted effective mastery for this concept (blocklist 7.3).
    pub fn effective_mastery(&self) -> f64 {
        effective_mastery(
            self.mastery_score,
            days_since(self.last_correct.as_deref()),
            self.ease_factor,
        )
    }
}

/// Approximate minutes one concept costs in a session (used for the estimate).
const MINUTES_PER_CONCEPT: i64 = 8;
/// Hard cap on total session size regardless of daily goal (keeps the queue
/// bounded — a 60-minute goal must not produce a 100-item queue).
const MAX_SESSION_CONCEPTS: usize = 12;

/// Load every concept's gating-relevant columns (pure read, bounded).
pub fn load_all(conn: &Connection) -> Result<Vec<ConceptStateRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, domain, COALESCE(difficulty_tier, 1), prerequisites, mastery_score, \
                    ease_factor, interval_days, next_review, last_correct, attempt_count \
             FROM concepts ORDER BY id LIMIT 2000",
        )
        .map_err(|e| format!("prepare load_all: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            let prereq_json: String = r.get(2)?;
            let prerequisites: Vec<String> = serde_json::from_str(&prereq_json).unwrap_or_default();
            Ok(ConceptStateRow {
                id: r.get(0)?,
                domain: r.get(1)?,
                difficulty_tier: r.get(2)?,
                prerequisites,
                mastery_score: r.get(4)?,
                ease_factor: r.get(5)?,
                interval_days: r.get(6)?,
                next_review: r.get(7)?,
                last_correct: r.get(8)?,
                attempt_count: r.get(9)?,
            })
        })
        .map_err(|e| format!("query load_all: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("row: {e}"))?);
    }
    Ok(out)
}

/// Classify a concept's UI state from its own mastery and its prerequisites'
/// DECAY-ADJUSTED effective mastery (blocklist 7.3). `eff` maps concept id →
/// effective mastery for prerequisite lookups.
pub fn classify_state(
    row: &ConceptStateRow,
    eff: &std::collections::HashMap<String, f64>,
) -> ConceptState {
    let unlocked = row
        .prerequisites
        .iter()
        .all(|p| eff.get(p).copied().unwrap_or(0.0) >= GATE_THRESHOLD);

    if !unlocked {
        return ConceptState::Locked;
    }
    if row.attempt_count == 0 {
        return ConceptState::Unlocked;
    }
    // Completed once effective mastery clears the same bar used for gating;
    // otherwise it is still being worked (in progress).
    if row.effective_mastery() >= GATE_THRESHOLD {
        ConceptState::Completed
    } else {
        ConceptState::InProgress
    }
}

/// Build the effective-mastery map for prerequisite gating.
pub fn effective_map(rows: &[ConceptStateRow]) -> std::collections::HashMap<String, f64> {
    rows.iter()
        .map(|r| (r.id.clone(), r.effective_mastery()))
        .collect()
}

/// How many NEW concepts to introduce this session: the `new_concepts_per_
/// session` setting, scaled UP for larger daily goals, then bounded. This is
/// always allowed to exceed one (v1's bug).
pub fn new_concept_budget(new_per_session: i64, daily_goal_minutes: i64) -> usize {
    let base = new_per_session.clamp(1, 10);
    // A larger daily goal affords more new material: +1 per extra 15 minutes
    // over the 15-minute floor.
    let goal_bonus = ((daily_goal_minutes - 15).max(0)) / 15;
    ((base + goal_bonus).max(1) as usize).min(MAX_SESSION_CONCEPTS)
}

/// Build today's session. Pure read; never writes (blocklist #0c).
pub fn build_session(
    conn: &Connection,
    new_per_session: i64,
    daily_goal_minutes: i64,
) -> Result<DailySession, String> {
    let rows = load_all(conn)?;
    let eff = effective_map(&rows);
    let today = chrono::Local::now().date_naive();

    // Candidate NEW concepts: unlocked, never attempted, in dependency-friendly
    // id order (curriculum ids are phase-ordered).
    let budget = new_concept_budget(new_per_session, daily_goal_minutes);
    let mut concepts_new: Vec<String> = rows
        .iter()
        .filter(|r| r.attempt_count == 0 && is_unlocked(r, &eff))
        .map(|r| r.id.clone())
        .take(budget)
        .collect();

    // Candidate REVIEWS: due (next_review <= today) OR forced (>60 days since
    // last review) OR mastery below the re-entry threshold. Prioritized by
    // decay level (lowest effective mastery first) and relationship to today's
    // new concepts (same domain bubbles up).
    let new_domains: std::collections::HashSet<&str> = rows
        .iter()
        .filter(|r| concepts_new.contains(&r.id))
        .map(|r| r.domain.as_str())
        .collect();

    let mut review_candidates: Vec<&ConceptStateRow> = rows
        .iter()
        .filter(|r| r.attempt_count > 0 && needs_review(r, today))
        .collect();

    review_candidates.sort_by(|a, b| {
        // Same-domain-as-new gets priority, then most-decayed (lowest effective
        // mastery) first — NOT merely most-overdue.
        let a_related = new_domains.contains(a.domain.as_str());
        let b_related = new_domains.contains(b.domain.as_str());
        b_related
            .cmp(&a_related)
            .then(a.effective_mastery().total_cmp(&b.effective_mastery()))
    });

    let review_budget = MAX_SESSION_CONCEPTS.saturating_sub(concepts_new.len());
    let concepts_review: Vec<String> = review_candidates
        .iter()
        .take(review_budget)
        .map(|r| r.id.clone())
        .collect();

    // If nothing is new AND nothing is due but some unlocked work exists, seed
    // at least one concept so the session is never empty on a fresh install.
    if concepts_new.is_empty() && concepts_review.is_empty() {
        if let Some(first) = rows.iter().find(|r| is_unlocked(r, &eff)) {
            concepts_new.push(first.id.clone());
        }
    }

    let interleaved_set = interleave(&concepts_new, &concepts_review);
    let estimated_minutes = (interleaved_set.len() as i64) * MINUTES_PER_CONCEPT;

    Ok(DailySession {
        concepts_new,
        concepts_review,
        interleaved_set,
        estimated_minutes,
    })
}

fn is_unlocked(row: &ConceptStateRow, eff: &std::collections::HashMap<String, f64>) -> bool {
    row.prerequisites
        .iter()
        .all(|p| eff.get(p).copied().unwrap_or(0.0) >= GATE_THRESHOLD)
}

/// A concept needs review if it is due, force-scheduled by the 60-day rule, or
/// its mastery has dropped below the re-entry threshold (blocklist 7.x).
fn needs_review(row: &ConceptStateRow, today: chrono::NaiveDate) -> bool {
    let due = row
        .next_review
        .as_deref()
        .and_then(|s| chrono::NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok())
        .map(|d| d <= today)
        .unwrap_or(true); // no next_review set but attempted → treat as due

    let forced = days_since(row.last_correct.as_deref())
        .map(|d| d >= FORCE_REVIEW_DAYS)
        .unwrap_or(false);

    let low_mastery = row.effective_mastery() < REENTRY_MASTERY;

    due || forced || low_mastery
}

/// Interleave new and review concepts so the queue alternates rather than
/// front-loading all-new-then-all-review (spacing aids retention). This is the
/// function v1 defined but never called (blocklist 7.5).
pub fn interleave(new: &[String], review: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(new.len() + review.len());
    let mut ni = new.iter();
    let mut ri = review.iter();
    loop {
        let n = ni.next();
        let r = ri.next();
        match (n, r) {
            (Some(n), Some(r)) => {
                out.push(n.clone());
                out.push(r.clone());
            }
            (Some(n), None) => out.push(n.clone()),
            (None, Some(r)) => out.push(r.clone()),
            (None, None) => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_allows_more_than_one_and_scales_with_goal() {
        // v1 bug: only ever one new concept. Here a high goal yields several.
        assert!(new_concept_budget(3, 60) > 1);
        assert_eq!(new_concept_budget(3, 15), 3);
        // +1 new per extra 15 min over the floor.
        assert_eq!(new_concept_budget(3, 60), 3 + 3);
    }

    #[test]
    fn budget_is_capped() {
        assert!(new_concept_budget(10, 60) <= 12);
    }

    #[test]
    fn interleave_weaves_new_and_review() {
        let out = interleave(
            &["n1".into(), "n2".into()],
            &["r1".into(), "r2".into(), "r3".into()],
        );
        // Alternates, then trails the extra review.
        assert_eq!(out, vec!["n1", "r1", "n2", "r2", "r3"]);
    }

    #[test]
    fn gating_uses_effective_not_raw_mastery() {
        // A prerequisite with high RAW mastery but heavy decay must NOT unlock a
        // dependent (the gate reads effective_mastery). Construct a prereq with
        // raw 0.95 but last reviewed long ago at low ease → effective < 0.8.
        let prereq = ConceptStateRow {
            id: "alg_001".into(),
            domain: "algebra".into(),
            difficulty_tier: 1,
            prerequisites: vec![],
            mastery_score: 0.95,
            ease_factor: 1.3,
            interval_days: 1,
            next_review: None,
            last_correct: Some(stale_date(120)),
            attempt_count: 5,
        };
        let dependent = ConceptStateRow {
            id: "alg_002".into(),
            domain: "algebra".into(),
            difficulty_tier: 1,
            prerequisites: vec!["alg_001".into()],
            mastery_score: 0.0,
            ease_factor: 2.5,
            interval_days: 1,
            next_review: None,
            last_correct: None,
            attempt_count: 0,
        };
        let rows = vec![prereq.clone(), dependent.clone()];
        let eff = effective_map(&rows);

        // The prereq's RAW mastery (0.95) clears the gate, but its EFFECTIVE
        // mastery after 120 days at ease 1.3 is well below 0.8.
        assert!(prereq.mastery_score >= GATE_THRESHOLD);
        assert!(prereq.effective_mastery() < GATE_THRESHOLD);
        assert_eq!(classify_state(&dependent, &eff), ConceptState::Locked);
    }

    fn stale_date(days_ago: i64) -> String {
        (chrono::Local::now().date_naive() - chrono::Duration::days(days_ago))
            .format("%Y-%m-%d")
            .to_string()
    }
}
