//! Minimal gamification (milestone 3, trimmed): XP only, BACKEND-authoritative.
//!
//! - XP is granted through exactly ONE path (`award_xp`) that appends a row to
//!   `xp_events` (storing BOTH `source` and `description`). The total is the SUM
//!   of `xp_events.amount` — there is no separately-mutated counter to drift out
//!   of sync, and no local frontend increment (blocklist #1).
//! - `GamificationState` keeps `level` and `badges` in the contract for forward
//!   compatibility, but there is NO level math (a fixed `LevelInfo` placeholder),
//!   so the v1 overflow bug (#0d) is structurally impossible. `badges` is always
//!   empty in slim v1 (#25 deferred).
//! - Streak state lives under ONE canonical key (`__streak_state`) read and
//!   written everywhere (blocklist #7) — never two spellings.
//! - Daily-goal progress reads REAL tracked study minutes from `session_minutes`
//!   (blocklist H1) — never a hardcoded 40%/100%.
//!
//! All XP grants for lessons/quizzes are guarded ONCE by a persisted marker (the
//! grant's `source` + a per-concept tag); the caller checks `already_awarded`
//! before calling `award_xp` so a lesson/quiz cannot farm XP (#4, #5).

use rusqlite::{params, Connection, OptionalExtension};

use crate::contract::{GamificationState, LevelInfo, StreakInfo, XpEvent};

/// Canonical streak state key (ONE spelling, used for read and write — #7).
const STREAK_KEY: &str = "__streak_state";
/// Fixed level title placeholder (Etta-themed; no legacy branding, no level math).
const LEVEL_TITLE: &str = "Learner";
/// How many recent XP events the state carries.
const RECENT_XP_LIMIT: i64 = 20;
/// XP awarded for completing a lesson / a quiz (each granted at most once).
pub const LESSON_XP: i64 = 10;
pub const QUIZ_XP: i64 = 20;

/// Append one XP grant. This is the ONLY way XP enters the system: the total is
/// always `SUM(amount)` over `xp_events`, so there is no counter to double-count
/// (#1). `amount` is clamped to the schema's 0..=100 range.
pub fn award_xp(
    conn: &Connection,
    amount: i64,
    source: &str,
    description: &str,
) -> Result<(), String> {
    let amount = amount.clamp(0, 100);
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO xp_events(amount, source, description, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![amount, source, description, now],
    )
    .map_err(|e| crate::util::internal_error("record the XP award", e))?;
    tracing::info!(amount, source, "xp awarded");
    Ok(())
}

/// Has an XP grant with this exact `source` already been recorded? Used to make
/// lesson/quiz XP one-shot (#4, #5). The caller composes a unique source such as
/// `"lesson:alg_001"` so the guard is per-concept.
pub fn already_awarded(conn: &Connection, source: &str) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM xp_events WHERE source = ?1",
            [source],
            |r| r.get(0),
        )
        .map_err(|e| crate::util::internal_error("check the XP award guard", e))?;
    Ok(n > 0)
}

/// Total XP = SUM(amount) over all events (single source of truth — #1).
pub fn total_xp(conn: &Connection) -> Result<i64, String> {
    let total: i64 = conn
        .query_row("SELECT COALESCE(SUM(amount), 0) FROM xp_events", [], |r| {
            r.get(0)
        })
        .map_err(|e| crate::util::internal_error("read your XP total", e))?;
    Ok(total)
}

fn recent_xp_events(conn: &Connection) -> Result<Vec<XpEvent>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT amount, source, description, created_at FROM xp_events \
             ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| crate::util::internal_error("read recent XP events", e))?;
    let rows = stmt
        .query_map([RECENT_XP_LIMIT], |r| {
            Ok(XpEvent {
                amount: r.get(0)?,
                source: r.get(1)?,
                description: r.get(2)?,
                created_at: r.get(3)?,
            })
        })
        .map_err(|e| crate::util::internal_error("read recent XP events", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| crate::util::internal_error("read recent XP events", e))?);
    }
    Ok(out)
}

/// Persisted streak state (serialized JSON under the single canonical key).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct StoredStreak {
    current_streak: i64,
    longest_streak: i64,
    freezes_available: i64,
    last_active_date: String,
}

fn read_streak(conn: &Connection) -> Result<StoredStreak, String> {
    match crate::settings::get_reserved(conn, STREAK_KEY)? {
        Some(s) => serde_json::from_str(&s)
            .map_err(|e| crate::util::internal_error("read your streak", e)),
        None => Ok(StoredStreak::default()),
    }
}

fn write_streak(conn: &Connection, s: &StoredStreak) -> Result<(), String> {
    let json = serde_json::to_string(s)
        .map_err(|e| crate::util::internal_error("save your streak", e))?;
    crate::settings::set_reserved(conn, STREAK_KEY, &json)
}

/// Record activity for `today` (YYYY-MM-DD), advancing the streak. Idempotent
/// within a day: a second call the same day does not double-count. A one-day
/// gap continues the streak; a larger gap resets it to 1. A NEGATIVE gap (the
/// clock rolled back — timezone hop, manual clock edit) is a no-op: it must
/// neither reset the streak nor rewind `last_active_date`. Returns the updated
/// streak.
///
/// NOTE on freezes: slim v1 never GRANTS a freeze (`freezes_available` starts
/// at 0 and nothing increments it), so the bridge branch below is dormant.
/// No user-facing copy may promise streak freezes until granting exists.
pub fn touch_streak(conn: &Connection, today: &str) -> Result<StreakInfo, String> {
    let mut s = read_streak(conn)?;

    if s.last_active_date == today {
        // Already counted today — no change.
        return Ok(to_streak_info(&s));
    }

    let gap = day_gap(&s.last_active_date, today);
    match gap {
        Some(g) if g < 0 => {
            // Clock rollback: `today` is BEFORE the last recorded activity.
            // Punishing the learner (reset) or rewinding last_active_date
            // would both corrupt the record — keep state exactly as is.
            return Ok(to_streak_info(&s));
        }
        Some(0) => {} // same day (handled above), unreachable here
        Some(1) => {
            s.current_streak += 1;
        }
        Some(2) if s.freezes_available > 0 => {
            // A single missed day bridged by a freeze keeps the streak alive
            // (dormant in slim v1 — see the doc comment above).
            s.freezes_available -= 1;
            s.current_streak += 1;
        }
        _ => {
            // First ever activity, or a gap too large to bridge → restart at 1.
            s.current_streak = 1;
        }
    }

    s.longest_streak = s.longest_streak.max(s.current_streak);
    s.last_active_date = today.to_string();
    write_streak(conn, &s)?;
    Ok(to_streak_info(&s))
}

fn to_streak_info(s: &StoredStreak) -> StreakInfo {
    StreakInfo {
        current_streak: s.current_streak,
        longest_streak: s.longest_streak,
        freezes_available: s.freezes_available,
        last_active_date: s.last_active_date.clone(),
    }
}

/// Whole-day gap between two `YYYY-MM-DD` dates, or None if `from` is empty/bad.
fn day_gap(from: &str, to: &str) -> Option<i64> {
    if from.is_empty() {
        return None;
    }
    let a = chrono::NaiveDate::parse_from_str(from, "%Y-%m-%d").ok()?;
    let b = chrono::NaiveDate::parse_from_str(to, "%Y-%m-%d").ok()?;
    Some((b - a).num_days())
}

/// Add `minutes` of study time to `date`'s tracked total (blocklist H1 / #25).
/// The daily-goal ring reads this real value — never a hardcoded percentage.
pub fn add_session_minutes(conn: &Connection, date: &str, minutes: i64) -> Result<(), String> {
    if minutes <= 0 {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO session_minutes(date, minutes) VALUES(?1, ?2) \
         ON CONFLICT(date) DO UPDATE SET minutes = minutes + excluded.minutes",
        params![date, minutes],
    )
    .map_err(|e| crate::util::internal_error("record your study minutes", e))?;
    Ok(())
}

/// Tracked study minutes for `date` (0 if none). Pure read.
pub fn minutes_for_date(conn: &Connection, date: &str) -> Result<i64, String> {
    let m: i64 = conn
        .query_row(
            "SELECT COALESCE(minutes, 0) FROM session_minutes WHERE date = ?1",
            [date],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| crate::util::internal_error("read your study minutes", e))?
        .unwrap_or(0);
    Ok(m)
}

/// Assemble the full gamification snapshot the frontend mirrors. XP is the live
/// SUM; level is a fixed placeholder (no math); badges are empty.
pub fn snapshot(conn: &Connection) -> Result<GamificationState, String> {
    let xp = total_xp(conn)?;
    let streak = read_streak(conn)?;
    let recent_xp_events = recent_xp_events(conn)?;

    Ok(GamificationState {
        xp,
        // Fixed LevelInfo — no level math (so #0d overflow is impossible).
        level: LevelInfo {
            level: 1,
            title: LEVEL_TITLE.to_string(),
            xp_into_level: xp,
            xp_for_next_level: xp + 1,
        },
        streak: to_streak_info(&streak),
        recent_xp_events,
        badges: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn xp_total_is_sum_of_events() {
        let conn = db();
        award_xp(&conn, 10, "lesson:alg_001", "lesson done").unwrap();
        award_xp(&conn, 20, "quiz:alg_001", "quiz done").unwrap();
        assert_eq!(total_xp(&conn).unwrap(), 30);
    }

    #[test]
    fn already_awarded_guards_one_shot() {
        let conn = db();
        assert!(!already_awarded(&conn, "lesson:alg_001").unwrap());
        award_xp(&conn, 10, "lesson:alg_001", "x").unwrap();
        assert!(already_awarded(&conn, "lesson:alg_001").unwrap());
    }

    #[test]
    fn streak_advances_then_holds_same_day() {
        let conn = db();
        let s1 = touch_streak(&conn, "2026-06-10").unwrap();
        assert_eq!(s1.current_streak, 1);
        let s2 = touch_streak(&conn, "2026-06-11").unwrap();
        assert_eq!(s2.current_streak, 2);
        // Same day again → no change.
        let s3 = touch_streak(&conn, "2026-06-11").unwrap();
        assert_eq!(s3.current_streak, 2);
        assert_eq!(s3.longest_streak, 2);
    }

    /// A clock rollback (negative day gap) must neither reset the streak nor
    /// rewind last_active_date; once the clock recovers, the streak continues.
    #[test]
    fn clock_rollback_does_not_reset_streak_or_rewind_date() {
        let conn = db();
        touch_streak(&conn, "2026-06-10").unwrap();
        let before = touch_streak(&conn, "2026-06-11").unwrap();
        assert_eq!(before.current_streak, 2);

        // Clock rolls back two days: no reset, no date rewind, nothing written.
        let rolled = touch_streak(&conn, "2026-06-09").unwrap();
        assert_eq!(rolled.current_streak, 2, "rollback must not reset");
        assert_eq!(
            rolled.last_active_date, "2026-06-11",
            "rollback must not rewind last_active_date"
        );

        // Clock recovers: the very next real day still continues the streak.
        let after = touch_streak(&conn, "2026-06-12").unwrap();
        assert_eq!(after.current_streak, 3);
    }

    #[test]
    fn streak_resets_after_large_gap() {
        let conn = db();
        touch_streak(&conn, "2026-06-01").unwrap();
        let s = touch_streak(&conn, "2026-06-10").unwrap();
        assert_eq!(s.current_streak, 1, "gap > freeze resets to 1");
        assert_eq!(s.longest_streak, 1);
    }

    #[test]
    fn session_minutes_accumulate() {
        let conn = db();
        add_session_minutes(&conn, "2026-06-11", 5).unwrap();
        add_session_minutes(&conn, "2026-06-11", 3).unwrap();
        assert_eq!(minutes_for_date(&conn, "2026-06-11").unwrap(), 8);
        assert_eq!(minutes_for_date(&conn, "2026-06-12").unwrap(), 0);
    }

    #[test]
    fn snapshot_has_fixed_level_and_no_badges() {
        let conn = db();
        award_xp(&conn, 15, "lesson:x", "x").unwrap();
        let snap = snapshot(&conn).unwrap();
        assert_eq!(snap.xp, 15);
        assert_eq!(snap.level.level, 1);
        assert_eq!(snap.level.title, "Learner");
        assert!(snap.badges.is_empty());
    }
}
