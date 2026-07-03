//! Content cache (simplified — NO HMAC integrity; blocklist #0b/#13).
//!
//! Payloads are stored as CLEAN JSON strings. Side-band metadata
//! (`mastery_band`, `model_version`) lives in its OWN columns — we NEVER append
//! HTML comments or any text onto the JSON payload (v1's bug appended
//! `<!-- mastery_band:high -->`, breaking every later parse).
//!
//! On read we parse the payload as real JSON; if parsing fails, the entry is
//! treated as a MISS (and logged), never as trusted content. No HMAC — the
//! threat model ("user tampers with their own learning content to cheat") is
//! self-defeating; SQLite under FileVault is the boundary.
//!
//! Hygiene: startup purges entries older than a 30-day TTL; reads skip entries
//! older than 7 days (staleness); we keep at most the 3 most recent per
//! (concept_id, content_type).

use rusqlite::{params, Connection, OptionalExtension};

const TTL_DAYS: i64 = 30;
const STALE_DAYS: i64 = 7;
const KEEP_PER_KEY: i64 = 3;

/// A cache hit: the row's id (the identity later reads/deletes can pin — the
/// quiz nonce), the parsed-valid payload, and its side-band metadata.
#[derive(Debug, Clone, PartialEq)]
pub struct CacheHit {
    pub id: i64,
    pub payload_json: String,
    pub mastery_band: Option<String>,
    pub model_version: Option<String>,
}

/// Write a cache entry. `payload_json` MUST already be a clean JSON string; we
/// validate it parses before storing so we never persist garbage. Side-band
/// metadata goes in its own columns. After insert we trim to the 3 most recent.
/// Returns the freshly inserted row's id (the trim keeps the newest rows, so
/// the just-inserted row always survives it) — `generate_quiz` hands this id
/// to the frontend as the quiz-instance nonce.
pub fn put(
    conn: &Connection,
    concept_id: &str,
    content_type: &str,
    payload_json: &str,
    mastery_band: Option<&str>,
    model_version: Option<&str>,
) -> Result<i64, String> {
    // Guard: refuse to store non-JSON. (Defense in depth; callers pass JSON.)
    serde_json::from_str::<serde_json::Value>(payload_json)
        .map_err(|e| format!("refusing to cache non-JSON payload: {e}"))?;

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO content_cache \
         (concept_id, content_type, payload_json, mastery_band, model_version, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            concept_id,
            content_type,
            payload_json,
            mastery_band,
            model_version,
            now
        ],
    )
    .map_err(|e| crate::util::internal_error("save content to the cache", e))?;
    let row_id = conn.last_insert_rowid();

    trim_to_recent(conn, concept_id, content_type)?;
    Ok(row_id)
}

/// Read the freshest valid cache entry for (concept_id, content_type), skipping
/// entries older than the staleness window. A payload that fails JSON parsing is
/// treated as a miss, DELETED (it can never become valid and would keep masking
/// older valid rows), and logged.
pub fn get(
    conn: &Connection,
    concept_id: &str,
    content_type: &str,
) -> Result<Option<CacheHit>, String> {
    get_impl(conn, concept_id, content_type, Some(stale_cutoff()), None)
}

/// Like `get`, but the entry must ALSO have been written for the SAME mastery
/// band and model version — a mismatch is a miss (WP5), so a learner crossing a
/// band threshold or switching models regenerates instead of being pinned to
/// stale content for the whole staleness window. Serving-path callers
/// (`generate_quiz`, the lesson path) use this; GRADING must not (see
/// `get_any` — grade against what the learner actually saw).
pub fn get_for(
    conn: &Connection,
    concept_id: &str,
    content_type: &str,
    mastery_band: &str,
    model_version: &str,
) -> Result<Option<CacheHit>, String> {
    get_impl(
        conn,
        concept_id,
        content_type,
        Some(stale_cutoff()),
        Some((mastery_band, model_version)),
    )
}

/// Read the newest valid entry REGARDLESS of the staleness window and of
/// band/model metadata — the 30-day TTL purge is the only bound. This is the
/// GRADING accessor: the grader must load the exact quiz the learner was
/// served, even if it has since crossed the 7-day serving window or the
/// learner's band/model drifted mid-quiz (R5).
pub fn get_any(
    conn: &Connection,
    concept_id: &str,
    content_type: &str,
) -> Result<Option<CacheHit>, String> {
    get_impl(conn, concept_id, content_type, None, None)
}

/// Load ONE specific cache row by its id, scoped to (concept_id, content_type)
/// so a stale or forged id can never cross concepts or content types. Ignores
/// the staleness window AND band/model metadata entirely — this is the
/// GRADING accessor (R5): the grader must load the exact quiz INSTANCE that
/// was served (identified by the nonce `generate_quiz` returned), even if it
/// has since crossed the 7-day serving window, the learner's band/model
/// drifted mid-quiz, or a newer quiz row landed for the same concept. The
/// 30-day TTL purge is the only bound. A corrupt (non-JSON) payload is
/// deleted and treated as a miss, like every other read.
pub fn get_by_id(
    conn: &Connection,
    concept_id: &str,
    content_type: &str,
    id: i64,
) -> Result<Option<CacheHit>, String> {
    let row = conn
        .query_row(
            "SELECT id, payload_json, mastery_band, model_version \
             FROM content_cache \
             WHERE id = ?1 AND concept_id = ?2 AND content_type = ?3",
            params![id, concept_id, content_type],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| crate::util::internal_error("read the content cache", e))?;

    let Some((id, payload_json, mastery_band, model_version)) = row else {
        return Ok(None);
    };
    if serde_json::from_str::<serde_json::Value>(&payload_json).is_err() {
        tracing::warn!(
            concept_id,
            content_type,
            row_id = id,
            "cache payload failed JSON parse; deleting corrupt row"
        );
        delete_by_id(conn, id)?;
        return Ok(None);
    }
    Ok(Some(CacheHit {
        id,
        payload_json,
        mastery_band,
        model_version,
    }))
}

/// Delete every cache row for (concept_id, content_type). Used after a quiz is
/// successfully recorded: the review screen has revealed the answer key, so a
/// retake must regenerate rather than replay (R5).
pub fn delete(conn: &Connection, concept_id: &str, content_type: &str) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM content_cache WHERE concept_id = ?1 AND content_type = ?2",
        params![concept_id, content_type],
    )
    .map_err(|e| crate::util::internal_error("clear the content cache", e))
}

/// Delete exactly ONE cache row by id. The quiz persist path uses this so
/// consuming a graded quiz removes only THAT instance's row — never a
/// concurrently generated quiz another window may still be answering.
pub fn delete_by_id(conn: &Connection, id: i64) -> Result<usize, String> {
    conn.execute("DELETE FROM content_cache WHERE id = ?1", params![id])
        .map_err(|e| crate::util::internal_error("clear the content cache", e))
}

fn stale_cutoff() -> String {
    (chrono::Utc::now() - chrono::Duration::days(STALE_DAYS)).to_rfc3339()
}

/// Shared read core. Loops so that a corrupt (non-JSON) newest row is deleted
/// and the next-newest candidate is considered, instead of one bad row masking
/// older valid ones until the TTL purge.
fn get_impl(
    conn: &Connection,
    concept_id: &str,
    content_type: &str,
    cutoff: Option<String>,
    expected: Option<(&str, &str)>,
) -> Result<Option<CacheHit>, String> {
    let (expected_band, expected_model) = match expected {
        Some((b, m)) => (Some(b), Some(m)),
        None => (None, None),
    };
    loop {
        let row = conn
            .query_row(
                "SELECT id, payload_json, mastery_band, model_version \
                 FROM content_cache \
                 WHERE concept_id = ?1 AND content_type = ?2 \
                   AND (?3 IS NULL OR created_at >= ?3) \
                   AND (?4 IS NULL OR mastery_band = ?4) \
                   AND (?5 IS NULL OR model_version = ?5) \
                 ORDER BY created_at DESC, id DESC LIMIT 1",
                params![
                    concept_id,
                    content_type,
                    cutoff,
                    expected_band,
                    expected_model
                ],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| crate::util::internal_error("read the content cache", e))?;

        let Some((id, payload_json, mastery_band, model_version)) = row else {
            return Ok(None);
        };

        // Parse as real JSON; a parse failure is a MISS, never trusted content.
        // Delete the corrupt row (it stops masking older valid rows) and retry.
        if serde_json::from_str::<serde_json::Value>(&payload_json).is_err() {
            tracing::warn!(
                concept_id,
                content_type,
                row_id = id,
                "cache payload failed JSON parse; deleting corrupt row"
            );
            conn.execute("DELETE FROM content_cache WHERE id = ?1", params![id])
                .map_err(|e| crate::util::internal_error("drop a corrupt cache row", e))?;
            continue;
        }

        return Ok(Some(CacheHit {
            id,
            payload_json,
            mastery_band,
            model_version,
        }));
    }
}

/// Keep only the `KEEP_PER_KEY` most recent rows for a (concept_id,
/// content_type); delete older ones.
fn trim_to_recent(conn: &Connection, concept_id: &str, content_type: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM content_cache \
         WHERE concept_id = ?1 AND content_type = ?2 AND id NOT IN ( \
            SELECT id FROM content_cache \
            WHERE concept_id = ?1 AND content_type = ?2 \
            ORDER BY created_at DESC, id DESC LIMIT ?3 )",
        params![concept_id, content_type, KEEP_PER_KEY],
    )
    .map_err(|e| crate::util::internal_error("trim the content cache", e))?;
    Ok(())
}

/// Startup hygiene: purge entries older than the 30-day TTL.
pub fn purge_expired(conn: &Connection) -> Result<usize, String> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(TTL_DAYS)).to_rfc3339();
    let n = conn
        .execute(
            "DELETE FROM content_cache WHERE created_at < ?1",
            params![cutoff],
        )
        .map_err(|e| crate::util::internal_error("purge the content cache", e))?;
    if n > 0 {
        tracing::info!(purged = n, "purged expired content_cache entries");
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO concepts(id, domain, module, title) VALUES('alg_001','algebra','m1','Intro')",
            [],
        )
        .unwrap();
        conn
    }

    /// write -> read with valid JSON returns content; a tampered (invalid JSON)
    /// payload returns a miss AND the corrupt row is deleted (R14b), so it can
    /// never mask older valid rows.
    #[test]
    fn valid_json_hits_tampered_json_misses() {
        let conn = db();
        put(
            &conn,
            "alg_001",
            "lesson",
            r#"{"a":1}"#,
            Some("low"),
            Some("m"),
        )
        .unwrap();
        let hit = get(&conn, "alg_001", "lesson").unwrap();
        assert!(hit.is_some());
        assert_eq!(hit.unwrap().mastery_band.as_deref(), Some("low"));

        // Simulate tampering: overwrite the stored payload with invalid JSON
        // directly (bypassing put's guard, as a malicious edit would).
        conn.execute(
            "UPDATE content_cache SET payload_json = '{not valid json' WHERE concept_id='alg_001'",
            [],
        )
        .unwrap();
        let miss = get(&conn, "alg_001", "lesson").unwrap();
        assert!(miss.is_none(), "tampered payload must read as a miss");
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM content_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "the corrupt row is deleted, not left to mask");
    }

    /// R14b: a corrupt NEWEST row no longer masks an older valid one — the
    /// read deletes it and serves the older valid payload in the same call.
    #[test]
    fn corrupt_newest_row_is_deleted_and_older_valid_row_served() {
        let conn = db();
        conn.execute(
            "INSERT INTO content_cache(concept_id, content_type, payload_json, created_at) \
             VALUES('alg_001','lesson','{\"v\":1}', ?1)",
            params![(chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO content_cache(concept_id, content_type, payload_json, created_at) \
             VALUES('alg_001','lesson','{corrupt', ?1)",
            params![chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();

        let hit = get(&conn, "alg_001", "lesson").unwrap().expect("older valid row served");
        assert_eq!(hit.payload_json, r#"{"v":1}"#);
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM content_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 1, "only the corrupt row was deleted");
    }

    /// WP5 (R3): the serving read misses on a mastery-band or model mismatch;
    /// the same entry still hits when both match.
    #[test]
    fn get_for_misses_on_band_or_model_mismatch() {
        let conn = db();
        put(
            &conn,
            "alg_001",
            "quiz",
            r#"{"q":1}"#,
            Some("low"),
            Some("claude-sonnet-4-6"),
        )
        .unwrap();

        assert!(
            get_for(&conn, "alg_001", "quiz", "low", "claude-sonnet-4-6")
                .unwrap()
                .is_some(),
            "matching band + model hits"
        );
        assert!(
            get_for(&conn, "alg_001", "quiz", "mid", "claude-sonnet-4-6")
                .unwrap()
                .is_none(),
            "band change is a miss"
        );
        assert!(
            get_for(&conn, "alg_001", "quiz", "low", "claude-opus-4-8")
                .unwrap()
                .is_none(),
            "model change is a miss"
        );
        // Rows written without metadata (legacy) never satisfy a metadata-
        // filtered read.
        conn.execute("DELETE FROM content_cache", []).unwrap();
        put(&conn, "alg_001", "quiz", r#"{"q":2}"#, None, None).unwrap();
        assert!(get_for(&conn, "alg_001", "quiz", "low", "claude-sonnet-4-6")
            .unwrap()
            .is_none());
    }

    /// R5: the grading read (`get_any`) still returns an entry older than the
    /// 7-day serving window (grade against what the learner saw) — while the
    /// serving reads treat it as a miss. `delete` then removes it.
    #[test]
    fn get_any_ignores_staleness_window_and_delete_clears() {
        let conn = db();
        let old = (chrono::Utc::now() - chrono::Duration::days(10)).to_rfc3339();
        conn.execute(
            "INSERT INTO content_cache(concept_id, content_type, payload_json, mastery_band, model_version, created_at) \
             VALUES('alg_001','quiz','{\"q\":1}','low','m', ?1)",
            params![old],
        )
        .unwrap();

        assert!(get(&conn, "alg_001", "quiz").unwrap().is_none(), "serving read: stale");
        assert!(
            get_for(&conn, "alg_001", "quiz", "low", "m").unwrap().is_none(),
            "filtered serving read: stale"
        );
        let hit = get_any(&conn, "alg_001", "quiz").unwrap();
        assert!(hit.is_some(), "grading read must still see the stale quiz");

        assert_eq!(delete(&conn, "alg_001", "quiz").unwrap(), 1);
        assert!(get_any(&conn, "alg_001", "quiz").unwrap().is_none());
    }

    /// Two entries written with the SAME created_at must resolve to the one
    /// inserted last (highest id). Without the `id DESC` tiebreaker the read
    /// could return the stale payload after a rapid regenerate.
    #[test]
    fn same_timestamp_returns_newest_by_id() {
        let conn = db();
        let ts = chrono::Utc::now().to_rfc3339();
        for payload in [r#"{"v":1}"#, r#"{"v":2}"#] {
            conn.execute(
                "INSERT INTO content_cache(concept_id, content_type, payload_json, created_at) \
                 VALUES('alg_001','lesson', ?1, ?2)",
                params![payload, ts],
            )
            .unwrap();
        }
        let hit = get(&conn, "alg_001", "lesson").unwrap().unwrap();
        assert_eq!(hit.payload_json, r#"{"v":2}"#, "newest row must win");
    }

    /// `put` returns the freshly inserted row's id (the quiz nonce), and
    /// `delete_by_id` removes ONLY that row — a second quiz instance for the
    /// same key survives its sibling's consumption.
    #[test]
    fn put_returns_row_id_and_delete_by_id_is_surgical() {
        let conn = db();
        let id1 = put(&conn, "alg_001", "quiz", r#"{"q":1}"#, None, None).unwrap();
        let id2 = put(&conn, "alg_001", "quiz", r#"{"q":2}"#, None, None).unwrap();
        assert!(id2 > id1, "ids are distinct and monotonic");
        assert_eq!(get_by_id(&conn, "alg_001", "quiz", id1).unwrap().unwrap().payload_json, r#"{"q":1}"#);

        assert_eq!(delete_by_id(&conn, id1).unwrap(), 1);
        assert!(get_by_id(&conn, "alg_001", "quiz", id1).unwrap().is_none());
        assert!(
            get_by_id(&conn, "alg_001", "quiz", id2).unwrap().is_some(),
            "the sibling row must survive"
        );
        assert_eq!(delete_by_id(&conn, id1).unwrap(), 0, "idempotent");
    }

    /// R5 (by-id grading read): `get_by_id` returns a row past the 7-day
    /// serving window regardless of band/model metadata — the served instance
    /// stays gradable until the 30-day purge. It is scoped to the exact
    /// (concept_id, content_type), so a forged or stale id can never cross
    /// concepts or content types; a corrupt payload is a deleted miss.
    #[test]
    fn get_by_id_ignores_staleness_but_is_scoped_and_parse_gated() {
        let conn = db();
        let old = (chrono::Utc::now() - chrono::Duration::days(10)).to_rfc3339();
        conn.execute(
            "INSERT INTO content_cache(concept_id, content_type, payload_json, mastery_band, model_version, created_at) \
             VALUES('alg_001','quiz','{\"q\":1}','low','m', ?1)",
            params![old],
        )
        .unwrap();
        let id = conn.last_insert_rowid();

        assert!(get(&conn, "alg_001", "quiz").unwrap().is_none(), "serving read: stale");
        let hit = get_by_id(&conn, "alg_001", "quiz", id).unwrap().expect("by-id read hits");
        assert_eq!(hit.id, id);
        assert_eq!(hit.payload_json, r#"{"q":1}"#);

        assert!(get_by_id(&conn, "alg_001", "lesson", id).unwrap().is_none(), "content_type scoped");
        assert!(get_by_id(&conn, "alg_999", "quiz", id).unwrap().is_none(), "concept scoped");
        assert!(get_by_id(&conn, "alg_001", "quiz", id + 999).unwrap().is_none(), "unknown id");

        // Corrupt payload: miss + the row is deleted.
        conn.execute("UPDATE content_cache SET payload_json = '{corrupt' WHERE id = ?1", params![id])
            .unwrap();
        assert!(get_by_id(&conn, "alg_001", "quiz", id).unwrap().is_none());
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM content_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 0, "corrupt row deleted");
    }

    #[test]
    fn keeps_only_three_most_recent() {
        let conn = db();
        for i in 0..5 {
            // Distinct created_at so ordering is deterministic.
            let ts = format!("2026-01-0{}T00:00:00Z", i + 1);
            conn.execute(
                "INSERT INTO content_cache(concept_id, content_type, payload_json, created_at) \
                 VALUES('alg_001','quiz', ?1, ?2)",
                params![format!(r#"{{"n":{i}}}"#), ts],
            )
            .unwrap();
            // Trigger trim via the public path on the last few inserts.
        }
        super::trim_to_recent(&conn, "alg_001", "quiz").unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM content_cache WHERE concept_id='alg_001' AND content_type='quiz'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 3);
    }
}
