//! SQLite data layer: the single connection held in Tauri app state behind a
//! Mutex, schema initialization (idempotent), and the daily backup. We never
//! open a connection per command — one pool/connection for the app lifetime.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

/// Embedded schema (Appendix B). Applied on every startup; idempotent.
const SCHEMA_SQL: &str = include_str!("schema.sql");

/// Tauri-managed application state. The DB connection lives behind a Mutex so
/// commands share one connection rather than opening a new one each call.
pub struct AppState {
    pub db: Mutex<Connection>,
    /// Directory where the DB and its timestamped backups live (app data dir).
    pub data_dir: PathBuf,
}

/// Open the connection, set the required PRAGMAs, and apply the schema.
/// `data_dir` is the app support directory; the DB file is `etta.db` within it.
pub fn open(data_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("create data dir: {e}"))?;
    let db_path = data_dir.join("etta.db");
    let conn = Connection::open(&db_path).map_err(|e| format!("open db: {e}"))?;
    configure(&conn)?;
    init_schema(&conn)?;
    Ok(conn)
}

/// Connection-level PRAGMAs. `journal_mode=WAL` and `auto_vacuum` must be set
/// before the schema is created to take effect for the lifetime of the DB.
fn configure(conn: &Connection) -> Result<(), String> {
    // auto_vacuum must be set before any table is created to take effect.
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")
        .map_err(|e| format!("auto_vacuum: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("journal_mode: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("foreign_keys: {e}"))?;
    Ok(())
}

/// Apply the schema. Every statement uses `IF NOT EXISTS`, so running this on an
/// already-initialized DB is a no-op (idempotent — verified by a test).
pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("apply schema: {e}"))?;
    Ok(())
}

/// On startup, if the most recent backup is older than 24h (or none exists),
/// copy the DB file to a timestamped file in the data dir. Best-effort: a
/// backup failure is logged but never blocks startup.
pub fn backup_if_stale(data_dir: &Path) {
    let db_path = data_dir.join("etta.db");
    if !db_path.exists() {
        return;
    }
    let now = chrono::Utc::now();
    if let Some(latest) = latest_backup_time(data_dir) {
        if now.signed_duration_since(latest) < chrono::Duration::hours(24) {
            return;
        }
    }
    let stamp = now.format("%Y%m%dT%H%M%SZ");
    let dest = data_dir.join(format!("etta-backup-{stamp}.db"));
    match std::fs::copy(&db_path, &dest) {
        Ok(_) => tracing::info!(backup = %dest.display(), "daily db backup written"),
        Err(e) => tracing::error!(error = %e, "daily db backup failed"),
    }
}

/// Most recent backup file's modified time, if any backups exist.
fn latest_backup_time(data_dir: &Path) -> Option<chrono::DateTime<chrono::Utc>> {
    let entries = std::fs::read_dir(data_dir).ok()?;
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("etta-backup-"))
        .filter_map(|e| e.metadata().ok()?.modified().ok())
        .map(chrono::DateTime::<chrono::Utc>::from)
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        // auto_vacuum/WAL are no-ops for :memory:, but schema + foreign_keys work.
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        init_schema(&conn).expect("apply schema");
        conn
    }

    /// Applying the schema twice is a no-op (idempotent) — acceptance criterion.
    #[test]
    fn schema_applies_idempotently_twice() {
        let conn = mem();
        // Second application must not error.
        init_schema(&conn).expect("second apply is a no-op");

        // All expected tables exist exactly once.
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN \
                 ('concepts','quiz_answers','submissions','settings','content_cache',\
                  'xp_events','mastery_snapshots','session_minutes')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 8, "all 8 tables present after double-apply");
    }

    /// The slim-v1 corrections are present: quiz_answers table and
    /// submissions.file_basename (not file_path).
    #[test]
    fn slim_v1_schema_corrections_present() {
        let conn = mem();
        let has_quiz_answers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='quiz_answers'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_quiz_answers, 1);

        let has_basename: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('submissions') WHERE name='file_basename'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_basename, 1, "submissions.file_basename exists");

        let has_file_path: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('submissions') WHERE name='file_path'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_file_path, 0, "submissions.file_path must NOT exist");

        // content_cache has no content_hash column (no HMAC in slim v1).
        let has_hash: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('content_cache') WHERE name='content_hash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_hash, 0, "content_cache.content_hash must NOT exist");
    }
}
