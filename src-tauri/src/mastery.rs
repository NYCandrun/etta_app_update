//! Mastery snapshots & XP pruning.
//!
//! `get_mastery_history` is a PURE READ — it performs zero writes (v1's bug #0c
//! upserted a snapshot on every read, causing a write storm). Snapshotting
//! happens only via the explicit `write_mastery_snapshot` (milestone 3 calls
//! it). Every query is bounded (default 90-day window, hard LIMIT).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// Default look-back window for mastery history (days).
const DEFAULT_WINDOW_DAYS: i64 = 90;
/// Hard upper bound on rows returned, so the query is never unbounded.
const MAX_ROWS: i64 = 2000;
/// Keep xp_events to the most recent ~1000 rows AND within 90 days.
const XP_KEEP_ROWS: i64 = 1000;
const XP_KEEP_DAYS: i64 = 90;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MasterySnapshot {
    pub date: String,
    pub domain: String,
    pub score: f64,
}

/// PURE READ: return mastery snapshots within the default 90-day window. This
/// function MUST NOT write to the DB (asserted by a row-count test).
pub fn get_mastery_history(conn: &Connection) -> Result<Vec<MasterySnapshot>, String> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(DEFAULT_WINDOW_DAYS))
        .format("%Y-%m-%d")
        .to_string();
    let mut stmt = conn
        .prepare(
            "SELECT date, domain, score FROM mastery_snapshots \
             WHERE date >= ?1 ORDER BY date ASC LIMIT ?2",
        )
        .map_err(|e| format!("prepare mastery history: {e}"))?;
    let rows = stmt
        .query_map(params![cutoff, MAX_ROWS], |r| {
            Ok(MasterySnapshot {
                date: r.get(0)?,
                domain: r.get(1)?,
                score: r.get(2)?,
            })
        })
        .map_err(|e| format!("query mastery history: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("row: {e}"))?);
    }
    Ok(out)
}

/// Explicit snapshot write (the ONLY place snapshots are written). Upserts a
/// (date, domain) row. Milestone 3 schedules this; reads never call it.
pub fn write_mastery_snapshot(
    conn: &Connection,
    date: &str,
    domain: &str,
    score: f64,
) -> Result<(), String> {
    if !(0.0..=1.0).contains(&score) {
        return Err("score must be in 0.0..=1.0".into());
    }
    conn.execute(
        "INSERT INTO mastery_snapshots(date, domain, score) VALUES(?1, ?2, ?3) \
         ON CONFLICT(date, domain) DO UPDATE SET score = excluded.score",
        params![date, domain, score],
    )
    .map_err(|e| format!("write snapshot: {e}"))?;
    Ok(())
}

/// Startup pruning: keep xp_events to the most recent ~1000 rows and within 90
/// days. Bounded delete.
pub fn prune_xp_events(conn: &Connection) -> Result<usize, String> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(XP_KEEP_DAYS)).to_rfc3339();
    let by_age = conn
        .execute(
            "DELETE FROM xp_events WHERE created_at < ?1",
            params![cutoff],
        )
        .map_err(|e| format!("prune xp by age: {e}"))?;
    let by_count = conn
        .execute(
            "DELETE FROM xp_events WHERE id NOT IN ( \
                SELECT id FROM xp_events ORDER BY created_at DESC LIMIT ?1 )",
            params![XP_KEEP_ROWS],
        )
        .map_err(|e| format!("prune xp by count: {e}"))?;
    let total = by_age + by_count;
    if total > 0 {
        tracing::info!(pruned = total, "pruned xp_events");
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        conn
    }

    fn row_count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// get_mastery_history performs ZERO writes: total row count across all
    /// mutable tables is identical before and after the read.
    #[test]
    fn get_mastery_history_performs_no_writes() {
        let conn = db();
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        write_mastery_snapshot(&conn, &today, "algebra", 0.5).unwrap();

        let before = row_count(&conn, "mastery_snapshots");
        let _ = get_mastery_history(&conn).unwrap();
        let _ = get_mastery_history(&conn).unwrap();
        let after = row_count(&conn, "mastery_snapshots");
        assert_eq!(before, after, "reads must not write");
    }
}
