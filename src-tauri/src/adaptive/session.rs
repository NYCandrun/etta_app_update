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
    /// Date (`YYYY-MM-DD`) of the most recent recorded attempt — right or
    /// wrong — derived from `quiz_answers.created_at`. `None` when the concept
    /// has no recorded answers.
    pub last_attempt_at: Option<String>,
    pub attempt_count: i64,
    /// True when this concept was marked mastered by a PLACEMENT DECISION (the
    /// reserved `__placement_seeded` set), not by real attempts. Such rows are
    /// exempt from decay and from the new/review queues until the learner
    /// genuinely attempts them (H16).
    pub placement_seeded: bool,
}

impl ConceptStateRow {
    /// Decay-adjusted effective mastery for this concept (blocklist 7.3).
    /// Placement-seeded, never-attempted rows do NOT decay: the seed is a
    /// placement decision, not a memory — there is nothing to forget until the
    /// learner actually attempts the concept (H16). Once genuinely attempted
    /// (attempt_count > 0) the normal forgetting curve applies, keyed to the
    /// last review ACTIVITY (see [`Self::last_activity`]).
    pub fn effective_mastery(&self) -> f64 {
        if self.placement_seeded && self.attempt_count == 0 {
            return self.mastery_score.clamp(0.0, 1.0);
        }
        effective_mastery(
            self.mastery_score,
            days_since(self.last_activity()),
            self.ease_factor,
        )
    }

    /// The decay clock keys to the most recent review ACTIVITY: the later of
    /// the last CORRECT answer and the last recorded attempt of any outcome.
    /// Keying to `last_correct` alone meant a concept the learner kept getting
    /// wrong never decayed (its clock never started), and a wrong-but-recent
    /// review didn't count as re-exposure. Both dates are `YYYY-MM-DD`, so the
    /// lexicographic max is the chronological max.
    fn last_activity(&self) -> Option<&str> {
        match (self.last_correct.as_deref(), self.last_attempt_at.as_deref()) {
            (Some(c), Some(a)) => Some(if c >= a { c } else { a }),
            (c, a) => c.or(a),
        }
    }
}

/// Approximate minutes one concept costs in a session (used for the estimate
/// and to derive the queue cap from the daily goal).
const MINUTES_PER_CONCEPT: i64 = 8;
/// Hard cap on total session size regardless of daily goal (keeps the queue
/// bounded — a 60-minute goal must not produce a 100-item queue).
const MAX_SESSION_CONCEPTS: usize = 12;
/// Floor on the daily-goal-derived queue cap: even the shortest goal gets a
/// meaningful session.
const MIN_SESSION_CONCEPTS: usize = 3;

/// Domains in curriculum order (phase-ordered, mirroring the DOMAINS list in
/// scripts/gen_curriculum.py — the single source of phase ranks). The index
/// encodes both the phase and the within-phase ordering, giving the total
/// order used for frontier detection and new-concept sorting (H19). Domains
/// not listed (test fixtures) rank before everything, like early material.
const DOMAIN_PHASE_ORDER: &[&str] = &[
    // phase 1
    "algebra",
    "trigonometry",
    "precalculus",
    // phase 2
    "single_variable_calculus",
    "multivariable_calculus",
    "linear_algebra",
    "differential_equations",
    // phase 3
    "classical_mechanics",
    "electromagnetism",
    "thermodynamics",
    "quantum_mechanics",
    // phase 4
    "astrophysics",
];

/// Phase-order rank of a domain (1-based; unknown domains rank 0).
fn domain_rank(domain: &str) -> usize {
    DOMAIN_PHASE_ORDER
        .iter()
        .position(|d| *d == domain)
        .map(|i| i + 1)
        .unwrap_or(0)
}

/// Total interleaved-queue cap derived from the daily goal at ~8 minutes per
/// concept, clamped to 3..=12: a 15-minute goal still gets a meaningful
/// session; a long goal stays bounded (queue_cap = clamp(goal/8, 3, 12)).
fn session_cap(daily_goal_minutes: i64) -> usize {
    ((daily_goal_minutes / MINUTES_PER_CONCEPT)
        .clamp(MIN_SESSION_CONCEPTS as i64, MAX_SESSION_CONCEPTS as i64)) as usize
}

/// Load every concept's gating-relevant columns (pure read, bounded). The
/// grouped LEFT JOIN pulls each concept's most recent attempt date from
/// `quiz_answers` in the same single query (the decay clock keys to last
/// ACTIVITY, not only last correct). `created_at` is stored RFC 3339 (UTC);
/// `date()` normalizes it to `YYYY-MM-DD` to match `last_correct`.
pub fn load_all(conn: &Connection) -> Result<Vec<ConceptStateRow>, String> {
    let seeded = crate::settings::get_placement_seeded(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.domain, COALESCE(c.difficulty_tier, 1), c.prerequisites, \
                    c.mastery_score, c.ease_factor, c.interval_days, c.next_review, \
                    c.last_correct, c.attempt_count, qa.last_attempt_at \
             FROM concepts c \
             LEFT JOIN (SELECT concept_id, date(MAX(created_at)) AS last_attempt_at \
                        FROM quiz_answers GROUP BY concept_id) qa \
               ON qa.concept_id = c.id \
             ORDER BY c.id LIMIT 2000",
        )
        .map_err(|e| crate::util::internal_error("read your concepts", e))?;
    let rows = stmt
        .query_map([], |r| {
            let id: String = r.get(0)?;
            let prereq_json: String = r.get(3)?;
            let prerequisites: Vec<String> = serde_json::from_str(&prereq_json).unwrap_or_default();
            Ok(ConceptStateRow {
                placement_seeded: seeded.contains(&id),
                id,
                domain: r.get(1)?,
                difficulty_tier: r.get(2)?,
                prerequisites,
                mastery_score: r.get(4)?,
                ease_factor: r.get(5)?,
                interval_days: r.get(6)?,
                next_review: r.get(7)?,
                last_correct: r.get(8)?,
                attempt_count: r.get(9)?,
                last_attempt_at: r.get(10)?,
            })
        })
        .map_err(|e| crate::util::internal_error("read your concepts", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| crate::util::internal_error("read your concepts", e))?);
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
    // Placement-seeded rows have attempt_count 0 but must present as completed
    // work (their seeded mastery clears the bar), not as fresh material (H16).
    if row.attempt_count == 0 && !row.placement_seeded {
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

    // The learner's FRONTIER domain (H19): the highest-ranked (phase-ordered)
    // domain showing any progress signal — a real attempt, a placement seed,
    // or seeded starting mastery. The mastery signal matters on day one: the
    // placement TARGET itself has zero attempts and is not in the seeded set,
    // but carries a seeded mastery_score > 0, and its domain must win the
    // race against unlocked siblings from alphabetically-earlier domains.
    let frontier_domain: Option<String> = rows
        .iter()
        .filter(|r| r.attempt_count > 0 || r.placement_seeded || r.mastery_score > 0.0)
        .max_by(|a, b| {
            domain_rank(&a.domain)
                .cmp(&domain_rank(&b.domain))
                .then(a.domain.cmp(&b.domain))
        })
        .map(|r| r.domain.clone());

    // Candidate NEW concepts: unlocked, never attempted — ordered frontier
    // domain first, then phase rank, then id (H19: plain id order let every
    // alphabetically-early domain starve later-phase domains, e.g. alg_* fed
    // for ~55 sessions before prec_001 after a precalculus placement).
    let total_cap = session_cap(daily_goal_minutes);
    let budget = new_concept_budget(new_per_session, daily_goal_minutes).min(total_cap);
    let mut new_candidates: Vec<&ConceptStateRow> = rows
        .iter()
        .filter(|r| r.attempt_count == 0 && !r.placement_seeded && is_unlocked(r, &eff))
        .collect();
    new_candidates.sort_by(|a, b| new_candidate_order(a, b, frontier_domain.as_deref()));
    let mut concepts_new: Vec<String> = new_candidates
        .iter()
        .take(budget)
        .map(|r| r.id.clone())
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

    // Reviews fill whatever the daily-goal-derived cap leaves after new work
    // (#20: total queue length tracks dailyGoalMinutes, not a fixed 12).
    let review_budget = total_cap.saturating_sub(concepts_new.len());
    let concepts_review: Vec<String> = review_candidates
        .iter()
        .take(review_budget)
        .map(|r| r.id.clone())
        .collect();

    // If nothing is new AND nothing is due but some unlocked work exists, seed
    // at least one concept so the session is never empty on a fresh install.
    // Never re-present already-COMPLETED work as "new" (a row whose effective
    // mastery clears the gate is done, not fresh material); pick by the same
    // frontier-first ordering as the regular new-concept queue.
    if concepts_new.is_empty() && concepts_review.is_empty() {
        if let Some(first) = rows
            .iter()
            .filter(|r| {
                !r.placement_seeded
                    && is_unlocked(r, &eff)
                    && classify_state(r, &eff) != ConceptState::Completed
            })
            .min_by(|a, b| new_candidate_order(a, b, frontier_domain.as_deref()))
        {
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

/// New-concept candidate ordering (H19): frontier-domain concepts first, then
/// ascending phase rank (earlier curriculum domains before later ones), then
/// id (the in-domain linear order). Used for both the regular new-concept
/// pick and the empty-session fallback so both agree.
fn new_candidate_order(
    a: &ConceptStateRow,
    b: &ConceptStateRow,
    frontier_domain: Option<&str>,
) -> std::cmp::Ordering {
    let a_frontier = frontier_domain == Some(a.domain.as_str());
    let b_frontier = frontier_domain == Some(b.domain.as_str());
    b_frontier
        .cmp(&a_frontier)
        .then(domain_rank(&a.domain).cmp(&domain_rank(&b.domain)))
        .then(a.id.cmp(&b.id))
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

    /// Regression (C2): `load_all` must map every SELECT column at its real
    /// index. The mapper once read `prerequisites` from index 2 — which is the
    /// COALESCEd `difficulty_tier` INTEGER — so `load_all` failed on the first
    /// row of ANY non-empty concepts table (rusqlite does not coerce
    /// Integer→String). Every other test bypasses the row mapper, so this test
    /// deliberately goes through a real SQLite DB and the project schema.
    #[test]
    fn load_all_round_trips_prerequisites_through_sqlite() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        // One row with real prerequisites and a NULL difficulty_tier (exercises
        // the COALESCE default), one bare row.
        conn.execute(
            "INSERT INTO concepts(id, domain, module, title, prerequisites, difficulty_tier) \
             VALUES('alg_002', 'algebra', 'm1', 'Dependent', '[\"alg_001\"]', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO concepts(id, domain, module, title, difficulty_tier) \
             VALUES('alg_001', 'algebra', 'm1', 'Base', 3)",
            [],
        )
        .unwrap();

        let rows = load_all(&conn).expect("load_all must map every column type");
        assert_eq!(rows.len(), 2);
        // Ordered by id: alg_001 first.
        assert_eq!(rows[0].id, "alg_001");
        assert!(rows[0].prerequisites.is_empty());
        assert_eq!(rows[0].difficulty_tier, 3);
        // The prerequisites JSON round-trips from its own column.
        assert_eq!(rows[1].id, "alg_002");
        assert_eq!(rows[1].prerequisites, vec!["alg_001".to_string()]);
        assert_eq!(rows[1].difficulty_tier, 1, "NULL tier coalesces to 1");
    }

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
            last_attempt_at: None,
            attempt_count: 5,
            placement_seeded: false,
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
            last_attempt_at: None,
            attempt_count: 0,
            placement_seeded: false,
        };
        let rows = vec![prereq.clone(), dependent.clone()];
        let eff = effective_map(&rows);

        // The prereq's RAW mastery (0.95) clears the gate, but its EFFECTIVE
        // mastery after 120 days at ease 1.3 is well below 0.8.
        assert!(prereq.mastery_score >= GATE_THRESHOLD);
        assert!(prereq.effective_mastery() < GATE_THRESHOLD);
        assert_eq!(classify_state(&dependent, &eff), ConceptState::Locked);
    }

    /// H16: a placement-seeded, never-attempted prerequisite does NOT decay —
    /// its effective mastery stays at the seeded value, the dependent stays
    /// unlocked after a break, and the seeded row presents as Completed. A
    /// GENUINELY attempted prerequisite with the same dates still decays and
    /// re-locks its dependent (the exemption is only for seeds).
    #[test]
    fn placement_seeded_prereq_does_not_decay_or_relock() {
        let seeded_prereq = ConceptStateRow {
            id: "alg_001".into(),
            domain: "algebra".into(),
            difficulty_tier: 1,
            prerequisites: vec![],
            mastery_score: 0.85,
            ease_factor: 2.5,
            interval_days: 1,
            next_review: None,
            last_correct: Some(stale_date(30)),
            last_attempt_at: None,
            attempt_count: 0,
            placement_seeded: true,
        };
        // Identical dates/mastery, but genuinely attempted → decays normally.
        let attempted_prereq = ConceptStateRow {
            id: "alg_010".into(),
            attempt_count: 4,
            placement_seeded: false,
            ..seeded_prereq.clone()
        };
        let dependent_on_seed = ConceptStateRow {
            id: "prec_001".into(),
            domain: "precalc".into(),
            difficulty_tier: 1,
            prerequisites: vec!["alg_001".into()],
            mastery_score: 0.3,
            ease_factor: 2.5,
            interval_days: 1,
            next_review: None,
            last_correct: None,
            last_attempt_at: None,
            attempt_count: 0,
            placement_seeded: false,
        };
        let dependent_on_attempted = ConceptStateRow {
            id: "prec_002".into(),
            prerequisites: vec!["alg_010".into()],
            ..dependent_on_seed.clone()
        };
        let rows = vec![
            seeded_prereq.clone(),
            attempted_prereq.clone(),
            dependent_on_seed.clone(),
            dependent_on_attempted.clone(),
        ];
        let eff = effective_map(&rows);

        // The seed does not decay; the real memory does.
        assert!((seeded_prereq.effective_mastery() - 0.85).abs() < 1e-9);
        assert!(attempted_prereq.effective_mastery() < GATE_THRESHOLD);

        // So the seed keeps its dependent open; the decayed real one re-locks.
        assert_eq!(
            classify_state(&dependent_on_seed, &eff),
            ConceptState::Unlocked
        );
        assert_eq!(
            classify_state(&dependent_on_attempted, &eff),
            ConceptState::Locked
        );
        // And the seeded prereq presents as completed work, not fresh material.
        assert_eq!(classify_state(&seeded_prereq, &eff), ConceptState::Completed);
    }

    fn stale_date(days_ago: i64) -> String {
        (chrono::Local::now().date_naive() - chrono::Duration::days(days_ago))
            .format("%Y-%m-%d")
            .to_string()
    }

    /// Insert a minimal concept row for the SQL-path tests below.
    fn insert_concept(conn: &rusqlite::Connection, id: &str, domain: &str, prereqs: &str) {
        conn.execute(
            "INSERT INTO concepts(id, domain, module, title, prerequisites) \
             VALUES(?1, ?2, 'm1', 'T', ?3)",
            rusqlite::params![id, domain, prereqs],
        )
        .unwrap();
    }

    /// Insert a quiz_answers attempt with an RFC 3339 `created_at` the given
    /// number of days in the past (matching the real write path's format).
    fn insert_attempt(conn: &rusqlite::Connection, concept_id: &str, days_ago: i64, correct: bool) {
        let at = (chrono::Utc::now() - chrono::Duration::days(days_ago)).to_rfc3339();
        conn.execute(
            "INSERT INTO quiz_answers(concept_id, question_id, question_type, prompt, \
                user_answer, is_correct, created_at) \
             VALUES(?1, 'q1', 'multiple_choice', 'p', 'a', ?2, ?3)",
            rusqlite::params![concept_id, correct as i64, at],
        )
        .unwrap();
    }

    /// Decay-clock rekey, through SQLite: the clock keys to the last ATTEMPT
    /// (any outcome), not only the last correct answer.
    /// (a) A concept the learner keeps getting WRONG (last_correct NULL) now
    ///     decays from its last attempt — the audit's "never-perfect concepts
    ///     never decay" hole is closed.
    /// (b) A recent wrong attempt REFRESHES the clock of a concept whose
    ///     last_correct is long past (re-exposure counts as review activity).
    #[test]
    fn decay_clock_keys_to_last_attempt_through_sqlite() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();

        // (a) never-correct, attempted 120 days ago.
        insert_concept(&conn, "alg_001", "algebra", "[]");
        conn.execute(
            "UPDATE concepts SET mastery_score = 0.75, attempt_count = 5 WHERE id = 'alg_001'",
            [],
        )
        .unwrap();
        insert_attempt(&conn, "alg_001", 120, false);

        // (b) last correct 90 days ago, but re-attempted (wrong) today.
        insert_concept(&conn, "alg_002", "algebra", "[]");
        conn.execute(
            "UPDATE concepts SET mastery_score = 0.75, attempt_count = 5, last_correct = ?1 \
             WHERE id = 'alg_002'",
            [stale_date(90)],
        )
        .unwrap();
        insert_attempt(&conn, "alg_002", 0, false);

        let rows = load_all(&conn).unwrap();
        let never_correct = rows.iter().find(|r| r.id == "alg_001").unwrap();
        let refreshed = rows.iter().find(|r| r.id == "alg_002").unwrap();

        // The JOIN surfaces the attempt date, normalized to YYYY-MM-DD.
        assert!(never_correct.last_attempt_at.is_some());
        assert_eq!(
            never_correct.last_attempt_at.as_deref().map(str::len),
            Some(10),
            "date() must normalize created_at to a bare date"
        );

        // (a) decays hard from the 120-day-old attempt (was: no decay at all,
        //     effective == raw 0.75 forever, since last_correct is NULL).
        assert!(
            never_correct.effective_mastery() < 0.5,
            "never-correct concepts must decay from their last attempt, got {}",
            never_correct.effective_mastery()
        );

        // (b) today's re-exposure resets the clock: effective stays near raw
        //     (keyed to last_correct alone it would be 0.75*exp(-90/35) ≈ 0.06).
        assert!(
            refreshed.effective_mastery() > 0.7,
            "a recent attempt must refresh the decay clock, got {}",
            refreshed.effective_mastery()
        );
    }

    #[test]
    fn session_cap_tracks_daily_goal_between_3_and_12() {
        assert_eq!(session_cap(15), 3, "short goal floors at 3");
        assert_eq!(session_cap(30), 3);
        assert_eq!(session_cap(45), 5);
        assert_eq!(session_cap(60), 7);
        assert_eq!(session_cap(120), 12, "long goal ceilings at 12");
    }

    /// #20 sizing, through SQLite: the TOTAL interleaved queue (new + review)
    /// is capped by the daily goal at ~8 min/concept, not by the fixed 12.
    #[test]
    fn total_queue_capped_by_daily_goal_through_sqlite() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        // 20 attempted, overdue review concepts + 2 fresh unlocked ones.
        for i in 0..20 {
            let id = format!("alg_{:03}", i + 1);
            insert_concept(&conn, &id, "algebra", "[]");
            conn.execute(
                "UPDATE concepts SET mastery_score = 0.5, attempt_count = 3, \
                    last_correct = ?2, next_review = ?2 WHERE id = ?1",
                rusqlite::params![id, stale_date(1)],
            )
            .unwrap();
        }
        insert_concept(&conn, "trig_001", "trigonometry", "[]");
        insert_concept(&conn, "trig_002", "trigonometry", "[]");

        // 15-minute goal → 3 total; the 2 new concepts leave 1 review slot.
        let s = build_session(&conn, 3, 15).unwrap();
        assert_eq!(s.interleaved_set.len(), 3, "15-min goal caps the queue at 3");
        assert_eq!(s.concepts_new.len(), 2);
        assert_eq!(s.concepts_review.len(), 1);
        assert_eq!(s.estimated_minutes, 3 * MINUTES_PER_CONCEPT);

        // 60-minute goal → 7 total.
        let s = build_session(&conn, 3, 60).unwrap();
        assert_eq!(s.interleaved_set.len(), 7, "60-min goal caps the queue at 7");
    }

    /// H19, through SQLite: new-concept candidates are ordered frontier-domain
    /// first, then phase rank, then id — NOT bare id order (which fed every
    /// alphabetically-early domain before later-phase domains). The learner's
    /// frontier here is single_variable_calculus; alg/astr siblings queue
    /// behind it in phase order.
    #[test]
    fn frontier_domain_leads_new_concepts_over_early_alphabet_siblings() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();

        // Real progress in SVC: completed svc_001 (fresh, not due for review).
        insert_concept(&conn, "svc_001", "single_variable_calculus", "[]");
        conn.execute(
            "UPDATE concepts SET mastery_score = 0.95, attempt_count = 4, \
                last_correct = ?1, next_review = ?2 WHERE id = 'svc_001'",
            rusqlite::params![stale_date(0), stale_date(-30)],
        )
        .unwrap();
        // Unlocked, unattempted candidates across three domains.
        insert_concept(&conn, "svc_002", "single_variable_calculus", r#"["svc_001"]"#);
        insert_concept(&conn, "alg_010", "algebra", "[]");
        insert_concept(&conn, "astr_001", "astrophysics", "[]");

        let s = build_session(&conn, 3, 30).unwrap();
        assert_eq!(
            s.concepts_new,
            vec![
                "svc_002".to_string(), // frontier domain leads
                "alg_010".to_string(), // then phase rank (algebra = phase 1)
                "astr_001".to_string() // then astrophysics (phase 4)
            ],
            "id order would have produced [alg_010, astr_001, svc_002]"
        );
        assert!(
            s.interleaved_set.first() == Some(&"svc_002".to_string()),
            "the frontier concept must lead the interleaved queue"
        );
    }

    /// Empty-session fallback, through SQLite: never re-present already-
    /// COMPLETED work as "new". With one completed and one in-progress (but
    /// not due) concept, the fallback picks the in-progress one; with ONLY
    /// completed work left, the session is honestly empty.
    #[test]
    fn empty_session_fallback_skips_completed_concepts() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();

        // Completed: high effective mastery, reviewed today, not due.
        insert_concept(&conn, "alg_001", "algebra", "[]");
        conn.execute(
            "UPDATE concepts SET mastery_score = 0.95, attempt_count = 4, \
                last_correct = ?1, next_review = ?2 WHERE id = 'alg_001'",
            rusqlite::params![stale_date(0), stale_date(-30)],
        )
        .unwrap();
        // In progress: mastery between REENTRY (0.6) and the gate (0.8),
        // reviewed today, not due → neither new nor review candidate.
        insert_concept(&conn, "alg_002", "algebra", "[]");
        conn.execute(
            "UPDATE concepts SET mastery_score = 0.7, attempt_count = 2, \
                last_correct = ?1, next_review = ?2 WHERE id = 'alg_002'",
            rusqlite::params![stale_date(0), stale_date(-30)],
        )
        .unwrap();

        let s = build_session(&conn, 3, 30).unwrap();
        assert_eq!(
            s.concepts_new,
            vec!["alg_002".to_string()],
            "fallback must pick the in-progress concept, not the completed one"
        );

        // Now the in-progress one is completed too → nothing to re-present.
        conn.execute(
            "UPDATE concepts SET mastery_score = 0.95 WHERE id = 'alg_002'",
            [],
        )
        .unwrap();
        let s = build_session(&conn, 3, 30).unwrap();
        assert!(
            s.interleaved_set.is_empty(),
            "an all-completed curriculum yields an empty session, not recycled work"
        );
    }
}
