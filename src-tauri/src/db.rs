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

impl AppState {
    /// Lock the shared connection (poisoned mutex → generic error). The ONE
    /// helper every command surface uses — never open a connection per call,
    /// never duplicate this lock-and-map dance in command modules.
    pub fn conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.db
            .lock()
            .map_err(|_| "internal db lock error".to_string())
    }
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
    migrate_content_cache_types(conn)?;
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("apply schema: {e}"))?;
    Ok(())
}

/// WP2 migration: `content_cache.content_type` gained 'lesson_reinforced'
/// (personalized lessons cache under their own key, C3). SQLite cannot ALTER a
/// CHECK constraint and `CREATE TABLE IF NOT EXISTS` never touches an existing
/// table, so a table created under the OLD constraint is DROPPED here and
/// recreated (with its index) by the schema batch that follows. Safe by
/// design: content_cache is a pure regenerable cache — losing it costs one
/// regeneration, never user data.
fn migrate_content_cache_types(conn: &Connection) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let ddl: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='content_cache'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("inspect content_cache schema: {e}"))?;
    if let Some(ddl) = ddl {
        if !ddl.contains("lesson_reinforced") {
            conn.execute_batch("DROP TABLE content_cache;")
                .map_err(|e| format!("migrate content_cache: {e}"))?;
            tracing::info!("content_cache rebuilt for the lesson_reinforced content type");
        }
    }
    Ok(())
}

/// How many timestamped backups to retain (newest first).
const BACKUP_KEEP: usize = 7;

/// On startup, if the most recent backup (by its FILENAME timestamp) is older
/// than 24h or none exists, write a consistent snapshot of the LIVE database
/// via `VACUUM INTO`, then prune old backups (keep the newest 7). Best-effort:
/// a backup failure is logged but never blocks startup.
///
/// A plain `fs::copy` of `etta.db` is NOT a valid backup here: the connection
/// runs `journal_mode=WAL`, so recently committed transactions live in
/// `etta.db-wal` until a checkpoint and a copy of the main file alone silently
/// drops them. `VACUUM INTO` snapshots through the live connection, so the
/// backup always contains every committed write.
pub fn backup_if_stale(conn: &Connection, data_dir: &Path) {
    let now = chrono::Utc::now();
    if let Some(latest) = latest_backup_time(data_dir) {
        if now.signed_duration_since(latest) < chrono::Duration::hours(24) {
            return;
        }
    }
    let stamp = now.format("%Y%m%dT%H%M%SZ");
    let dest = data_dir.join(format!("etta-backup-{stamp}.db"));
    match conn.execute("VACUUM INTO ?1", [dest.to_string_lossy().as_ref()]) {
        Ok(_) => tracing::info!(backup = %dest.display(), "daily db backup written"),
        Err(e) => tracing::error!(error = %e, "daily db backup failed"),
    }
    prune_old_backups(data_dir);
}

/// Most recent backup time, parsed from the backup FILENAMES (never mtime —
/// file copies and restores rewrite mtime, which would silently defeat the
/// 24h staleness gate).
fn latest_backup_time(data_dir: &Path) -> Option<chrono::DateTime<chrono::Utc>> {
    let entries = std::fs::read_dir(data_dir).ok()?;
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| backup_stamp(&e.file_name().to_string_lossy()))
        .max()
}

/// Parse the UTC timestamp out of an `etta-backup-<stamp>.db` filename.
fn backup_stamp(file_name: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let stamp = file_name
        .strip_prefix("etta-backup-")?
        .strip_suffix(".db")?;
    chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%M%SZ")
        .ok()
        .map(|n| n.and_utc())
}

/// Delete all but the `BACKUP_KEEP` newest backups (by filename timestamp,
/// which sorts lexicographically). Best-effort; failures are logged.
fn prune_old_backups(data_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(data_dir) else {
        return;
    };
    let mut backups: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| backup_stamp(n).is_some())
        })
        .collect();
    backups.sort();
    let excess = backups.len().saturating_sub(BACKUP_KEEP);
    for victim in backups.into_iter().take(excess) {
        if let Err(e) = std::fs::remove_file(&victim) {
            tracing::warn!(error = %e, file = %victim.display(), "backup prune failed");
        }
    }
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

    /// WP2 migration: a content_cache table created under the OLD CHECK
    /// constraint (no 'lesson_reinforced') is rebuilt on init, after which a
    /// reinforced-lesson row inserts cleanly. A fresh table is left alone.
    #[test]
    fn content_cache_check_migration_rebuilds_old_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        // Simulate a pre-WP2 database: the old constraint, with a row in it.
        conn.execute_batch(
            "CREATE TABLE content_cache (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                concept_id      TEXT NOT NULL,
                content_type    TEXT NOT NULL CHECK(content_type IN ('lesson','quiz','explain','review')),
                payload_json    TEXT NOT NULL,
                mastery_band    TEXT,
                model_version   TEXT,
                created_at      TEXT NOT NULL
             );
             INSERT INTO content_cache(concept_id, content_type, payload_json, created_at)
             VALUES('alg_001','lesson','{}','2026-01-01T00:00:00Z');",
        )
        .unwrap();

        init_schema(&conn).expect("init migrates the old table");

        // The old (regenerable) contents are gone with the rebuild...
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM content_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "old cache rows dropped with the rebuild");
        // ...and the new type now inserts cleanly.
        conn.execute(
            "INSERT INTO concepts(id, domain, module, title) VALUES('alg_001','algebra','m1','Intro')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO content_cache(concept_id, content_type, payload_json, created_at) \
             VALUES('alg_001','lesson_reinforced','{}','2026-01-01T00:00:00Z')",
            [],
        )
        .expect("lesson_reinforced accepted after migration");

        // Re-running init on the NEW table is a no-op (row survives).
        init_schema(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM content_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "an up-to-date table is never rebuilt");
    }

    /// Fresh, unique on-disk directory for backup tests (VACUUM INTO and WAL
    /// need real files; :memory: cannot exercise them).
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "etta-db-test-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn backup_files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("etta-backup-") && n.ends_with(".db"))
            .collect();
        names.sort();
        names
    }

    /// Regression (H17): the backup must contain commits that still live in the
    /// WAL. The old `fs::copy(etta.db)` approach silently dropped them; the
    /// `VACUUM INTO` snapshot must include every committed write.
    #[test]
    fn backup_contains_wal_resident_commits() {
        let dir = temp_dir("wal");
        let conn = open(&dir).expect("open on-disk db");
        conn.execute(
            "INSERT INTO concepts(id, domain, module, title) \
             VALUES('alg_001','algebra','m1','Intro')",
            [],
        )
        .unwrap();

        backup_if_stale(&conn, &dir);

        let backups = backup_files(&dir);
        assert_eq!(backups.len(), 1, "one backup written");
        let bconn = Connection::open(dir.join(&backups[0])).unwrap();
        let n: i64 = bconn
            .query_row(
                "SELECT COUNT(*) FROM concepts WHERE id = 'alg_001'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "backup must include WAL-resident commits");
        drop(bconn);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Staleness is judged by the FILENAME timestamp, not mtime: a backup file
    /// whose name says 2020 (but whose mtime is now) must count as stale, and a
    /// fresh backup must then be written.
    #[test]
    fn staleness_uses_filename_timestamp_not_mtime() {
        let dir = temp_dir("stale");
        std::fs::write(dir.join("etta-backup-20200101T000000Z.db"), b"old").unwrap();

        let parsed = super::latest_backup_time(&dir).expect("stamp parses");
        assert_eq!(parsed.format("%Y").to_string(), "2020");

        let conn = open(&dir).expect("open on-disk db");
        backup_if_stale(&conn, &dir);
        assert_eq!(
            backup_files(&dir).len(),
            2,
            "an old-by-name backup must not suppress a new one"
        );

        // A second run within 24h of the new backup is a no-op.
        backup_if_stale(&conn, &dir);
        assert_eq!(backup_files(&dir).len(), 2, "fresh backup gates a rerun");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Retention: only the 7 newest backups survive pruning.
    #[test]
    fn prune_keeps_only_seven_newest_backups() {
        let dir = temp_dir("prune");
        for day in 1..=9 {
            let name = format!("etta-backup-2026010{day}T000000Z.db");
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        super::prune_old_backups(&dir);
        let names = backup_files(&dir);
        assert_eq!(names.len(), 7);
        assert_eq!(
            names[0], "etta-backup-20260103T000000Z.db",
            "the two OLDEST are pruned"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
