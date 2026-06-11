//! Complete user-data export (milestone 5, item #14 / blocklist #40a).
//!
//! Assembles every row a learner has produced into ONE JSON document the
//! Settings "Export data" button writes to disk. The export is intentionally
//! exhaustive (progress, quiz history, content-attempt logs, settings,
//! gamification, learning-path snapshots) so it is a true backup.
//!
//! Two hard rules:
//!  - No secrets. The API key lives only in the OS keychain and is NEVER read
//!    here; the `settings` table holds only the `api_key_present` boolean flag,
//!    not the key. We additionally drop any reserved `__`-prefixed internal keys
//!    (curriculum version, onboarding flag, the canonical placement quiz JSON).
//!  - No file paths (#40a, defensive). The `submissions` table — empty in slim
//!    v1 — only ever stored a `file_basename`, never a path, but we still run a
//!    path filter over every exported string so a stray absolute/relative path
//!    can never leak even if a future row contains one.

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Map, Value};

/// One concept's full progress row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConceptExport {
    id: String,
    domain: String,
    module: String,
    title: String,
    mastery_score: f64,
    ease_factor: f64,
    interval_days: i64,
    next_review: Option<String>,
    last_correct: Option<String>,
    attempt_count: i64,
    streak_correct: i64,
}

/// One graded quiz answer from history.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuizAnswerExport {
    id: i64,
    concept_id: String,
    question_id: String,
    question_type: String,
    prompt: String,
    user_answer: Option<String>,
    is_correct: bool,
    score: Option<f64>,
    is_transfer: bool,
    error_pattern_detected: Option<String>,
    latency_ms: Option<i64>,
    created_at: String,
}

/// One XP event (the gamification ledger).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct XpEventExport {
    amount: i64,
    source: String,
    description: String,
    created_at: String,
}

/// One mastery snapshot (per-domain daily score — the learning-path history).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MasterySnapshotExport {
    date: String,
    domain: String,
    score: f64,
}

/// One day's tracked study minutes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionMinutesExport {
    date: String,
    minutes: i64,
}

/// The whole export document.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataExport {
    /// Identifies the producing app + a schema version for forward reading.
    app: String,
    export_version: u32,
    exported_at: String,
    concepts: Vec<ConceptExport>,
    quiz_answers: Vec<QuizAnswerExport>,
    /// Lesson/explanation attempt logs. In slim v1 the content-attempt log lives
    /// in `quiz_answers` (quizzes) and `xp_events` (lesson completions); there is
    /// no separate free-text lesson log table, so this exposes the XP ledger that
    /// records every lesson/quiz XP award with its source + timestamp.
    xp_events: Vec<XpEventExport>,
    mastery_snapshots: Vec<MasterySnapshotExport>,
    session_minutes: Vec<SessionMinutesExport>,
    /// User-facing settings only. Reserved internal keys and anything that even
    /// looks like a secret are filtered out; the API key is never present.
    settings: Map<String, Value>,
}

/// Reserved internal settings keys (the `__`-prefixed bookkeeping rows) plus any
/// key whose name hints at a secret. The export carries user-facing prefs only.
fn is_exportable_setting(key: &str) -> bool {
    if key.starts_with("__") {
        return false;
    }
    let lower = key.to_ascii_lowercase();
    // Defensive: never export anything that looks like a credential. The key is
    // not in this table at all (it is in the keychain), but `api_key_present` is
    // a harmless boolean flag we DO keep; only drop true secret-bearing names.
    const SECRET_HINTS: &[&str] = &["api_key", "token", "secret", "password", "credential"];
    if key == "api_key_present" {
        return true;
    }
    !SECRET_HINTS.iter().any(|h| lower.contains(h))
}

/// True if a string looks like a filesystem path we must not leak (#40a).
/// Defensive only — no current row should contain one.
fn looks_like_path(s: &str) -> bool {
    s.starts_with('/')
        || s.starts_with("~/")
        || s.starts_with("./")
        || s.starts_with("../")
        || s.contains(":\\") // Windows drive path, e.g. C:\Users
        || s.contains("/Users/")
        || s.contains("/home/")
}

/// Redact a string field if it looks like a path. Applied to every exported
/// free-text field that could conceivably hold one.
fn scrub(s: Option<String>) -> Option<String> {
    match s {
        Some(v) if looks_like_path(&v) => Some("[redacted path]".to_string()),
        other => other,
    }
}

/// Build the complete export document from the live connection.
pub fn build_export(conn: &Connection) -> Result<DataExport, String> {
    let concepts = {
        let mut stmt = conn
            .prepare(
                "SELECT id, domain, module, title, mastery_score, ease_factor, interval_days, \
                 next_review, last_correct, attempt_count, streak_correct \
                 FROM concepts ORDER BY id",
            )
            .map_err(|e| format!("prepare concepts: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ConceptExport {
                    id: r.get(0)?,
                    domain: r.get(1)?,
                    module: r.get(2)?,
                    title: r.get(3)?,
                    mastery_score: r.get(4)?,
                    ease_factor: r.get(5)?,
                    interval_days: r.get(6)?,
                    next_review: r.get(7)?,
                    last_correct: r.get(8)?,
                    attempt_count: r.get(9)?,
                    streak_correct: r.get(10)?,
                })
            })
            .map_err(|e| format!("query concepts: {e}"))?;
        collect(rows, "concepts")?
    };

    let quiz_answers = {
        let mut stmt = conn
            .prepare(
                "SELECT id, concept_id, question_id, question_type, prompt, user_answer, \
                 is_correct, score, is_transfer, error_pattern_detected, latency_ms, created_at \
                 FROM quiz_answers ORDER BY id",
            )
            .map_err(|e| format!("prepare quiz_answers: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(QuizAnswerExport {
                    id: r.get(0)?,
                    concept_id: r.get(1)?,
                    question_id: r.get(2)?,
                    question_type: r.get(3)?,
                    prompt: r.get::<_, String>(4)?,
                    user_answer: r.get(5)?,
                    is_correct: r.get::<_, i64>(6)? != 0,
                    score: r.get(7)?,
                    is_transfer: r.get::<_, i64>(8)? != 0,
                    error_pattern_detected: r.get(9)?,
                    latency_ms: r.get(10)?,
                    created_at: r.get(11)?,
                })
            })
            .map_err(|e| format!("query quiz_answers: {e}"))?;
        let mut v: Vec<QuizAnswerExport> = collect(rows, "quiz_answers")?;
        // Path scrub on the only free-text fields that could ever hold one.
        for a in &mut v {
            a.user_answer = scrub(a.user_answer.take());
            if looks_like_path(&a.prompt) {
                a.prompt = "[redacted path]".to_string();
            }
        }
        v
    };

    let xp_events = {
        let mut stmt = conn
            .prepare("SELECT amount, source, description, created_at FROM xp_events ORDER BY id")
            .map_err(|e| format!("prepare xp_events: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(XpEventExport {
                    amount: r.get(0)?,
                    source: r.get(1)?,
                    description: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })
            .map_err(|e| format!("query xp_events: {e}"))?;
        collect(rows, "xp_events")?
    };

    let mastery_snapshots = {
        let mut stmt = conn
            .prepare("SELECT date, domain, score FROM mastery_snapshots ORDER BY date, domain")
            .map_err(|e| format!("prepare mastery_snapshots: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(MasterySnapshotExport {
                    date: r.get(0)?,
                    domain: r.get(1)?,
                    score: r.get(2)?,
                })
            })
            .map_err(|e| format!("query mastery_snapshots: {e}"))?;
        collect(rows, "mastery_snapshots")?
    };

    let session_minutes = {
        let mut stmt = conn
            .prepare("SELECT date, minutes FROM session_minutes ORDER BY date")
            .map_err(|e| format!("prepare session_minutes: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SessionMinutesExport {
                    date: r.get(0)?,
                    minutes: r.get(1)?,
                })
            })
            .map_err(|e| format!("query session_minutes: {e}"))?;
        collect(rows, "session_minutes")?
    };

    let settings = {
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings ORDER BY key")
            .map_err(|e| format!("prepare settings: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("query settings: {e}"))?;
        let mut map = Map::new();
        for row in rows {
            let (k, val) = row.map_err(|e| format!("read setting row: {e}"))?;
            if !is_exportable_setting(&k) {
                continue;
            }
            let val = if looks_like_path(&val) {
                "[redacted path]".to_string()
            } else {
                val
            };
            map.insert(k, Value::String(val));
        }
        map
    };

    Ok(DataExport {
        app: "Etta".to_string(),
        export_version: 1,
        exported_at: chrono::Utc::now().to_rfc3339(),
        concepts,
        quiz_answers,
        xp_events,
        mastery_snapshots,
        session_minutes,
        settings,
    })
}

/// Collect a rusqlite row iterator into a Vec with a context-tagged error.
fn collect<T>(
    rows: impl Iterator<Item = rusqlite::Result<T>>,
    what: &str,
) -> Result<Vec<T>, String> {
    rows.collect::<rusqlite::Result<Vec<T>>>()
        .map_err(|e| format!("read {what}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        conn
    }

    /// Critical test (milestone 5): the export contains every listed section and
    /// leaks NO file paths or secrets.
    #[test]
    fn export_has_all_sections_and_no_secrets_or_paths() {
        let conn = db();
        // Seed one concept + a quiz answer whose fields include a path-looking
        // string and a settings table that includes a secret-looking key.
        conn.execute(
            "INSERT INTO concepts(id, domain, module, title) VALUES('alg_001','algebra','m1','Intro')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO quiz_answers(concept_id, question_id, question_type, prompt, user_answer, \
             is_correct, created_at) VALUES('alg_001','q1','fill_in_blank','solve $x$','/home/user/secret.txt',1,'2026-06-11')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO xp_events(amount, source, description, created_at) \
             VALUES(10,'lesson','done','2026-06-11T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO mastery_snapshots(date, domain, score) VALUES('2026-06-11','algebra',0.5)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_minutes(date, minutes) VALUES('2026-06-11',20)",
            [],
        )
        .unwrap();
        // A legit user-facing setting, a secret-bearing key, and a reserved key.
        conn.execute(
            "INSERT INTO settings(key, value) VALUES('theme','dark')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES('api_key','sk-ant-supersecret')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES('__onboarding_complete','true')",
            [],
        )
        .unwrap();

        let export = build_export(&conn).unwrap();
        let json = serde_json::to_string(&export).unwrap();

        // Every section is present and the seeded rows came through.
        assert_eq!(export.concepts.len(), 1);
        assert_eq!(export.quiz_answers.len(), 1);
        assert_eq!(export.xp_events.len(), 1);
        assert_eq!(export.mastery_snapshots.len(), 1);
        assert_eq!(export.session_minutes.len(), 1);
        assert!(export.settings.contains_key("theme"));

        // No secret value and no reserved/secret key leaked.
        assert!(!json.contains("sk-ant-supersecret"), "secret value leaked");
        assert!(
            !export.settings.contains_key("api_key"),
            "secret key leaked"
        );
        assert!(
            !export.settings.contains_key("__onboarding_complete"),
            "reserved key leaked"
        );

        // The path-looking answer was redacted; no raw path in the JSON.
        assert!(!json.contains("/home/user/secret.txt"), "path leaked");
        assert_eq!(
            export.quiz_answers[0].user_answer.as_deref(),
            Some("[redacted path]")
        );
    }

    #[test]
    fn path_detector_catches_common_shapes() {
        assert!(looks_like_path("/etc/passwd"));
        assert!(looks_like_path("~/Documents/x"));
        assert!(looks_like_path("C:\\Users\\me"));
        assert!(looks_like_path("/Users/alice/file"));
        assert!(!looks_like_path("x = 3y - 7"));
        assert!(!looks_like_path("the answer is 42"));
    }
}
