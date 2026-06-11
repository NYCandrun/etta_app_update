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

/// A cache hit: the parsed-valid payload plus its side-band metadata.
#[derive(Debug, Clone, PartialEq)]
pub struct CacheHit {
    pub payload_json: String,
    pub mastery_band: Option<String>,
    pub model_version: Option<String>,
}

/// Write a cache entry. `payload_json` MUST already be a clean JSON string; we
/// validate it parses before storing so we never persist garbage. Side-band
/// metadata goes in its own columns. After insert we trim to the 3 most recent.
pub fn put(
    conn: &Connection,
    concept_id: &str,
    content_type: &str,
    payload_json: &str,
    mastery_band: Option<&str>,
    model_version: Option<&str>,
) -> Result<(), String> {
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
    .map_err(|e| format!("cache insert: {e}"))?;

    trim_to_recent(conn, concept_id, content_type)?;
    Ok(())
}

/// Read the freshest valid cache entry for (concept_id, content_type), skipping
/// entries older than the staleness window. A payload that fails JSON parsing is
/// treated as a miss (returns Ok(None)) and logged.
pub fn get(
    conn: &Connection,
    concept_id: &str,
    content_type: &str,
) -> Result<Option<CacheHit>, String> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(STALE_DAYS)).to_rfc3339();
    let row = conn
        .query_row(
            "SELECT payload_json, mastery_band, model_version \
             FROM content_cache \
             WHERE concept_id = ?1 AND content_type = ?2 AND created_at >= ?3 \
             ORDER BY created_at DESC LIMIT 1",
            params![concept_id, content_type, cutoff],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("cache read: {e}"))?;

    let Some((payload_json, mastery_band, model_version)) = row else {
        return Ok(None);
    };

    // Parse as real JSON; a parse failure is a MISS, never trusted content.
    if serde_json::from_str::<serde_json::Value>(&payload_json).is_err() {
        tracing::warn!(
            concept_id,
            content_type,
            "cache payload failed JSON parse; treating as miss"
        );
        return Ok(None);
    }

    Ok(Some(CacheHit {
        payload_json,
        mastery_band,
        model_version,
    }))
}

/// Keep only the `KEEP_PER_KEY` most recent rows for a (concept_id,
/// content_type); delete older ones.
fn trim_to_recent(conn: &Connection, concept_id: &str, content_type: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM content_cache \
         WHERE concept_id = ?1 AND content_type = ?2 AND id NOT IN ( \
            SELECT id FROM content_cache \
            WHERE concept_id = ?1 AND content_type = ?2 \
            ORDER BY created_at DESC LIMIT ?3 )",
        params![concept_id, content_type, KEEP_PER_KEY],
    )
    .map_err(|e| format!("cache trim: {e}"))?;
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
        .map_err(|e| format!("cache purge: {e}"))?;
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
    /// payload returns a miss.
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
