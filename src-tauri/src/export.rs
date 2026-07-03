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
//!    v1 — only ever stored a `file_basename`, never a path. We additionally
//!    run the path filter over the exported fields that carry learner- or
//!    model-produced free text — exactly these: `quiz_answers.user_answer`,
//!    `quiz_answers.prompt`, `quiz_answers.error_pattern_detected` (the
//!    grader's pattern can echo a path-bearing user answer verbatim), and
//!    every `settings` value. Structured fields (ids, dates, scores, XP
//!    descriptions, curriculum titles) are app-produced, never free text, and
//!    are not scrubbed. Known accepted gap: classic HFS colon paths
//!    ("Macintosh HD:Users:jacob:notes.txt") are not detected — the shape is
//!    indistinguishable from prose with colons.

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

/// True if a string looks like a REAL filesystem path we must not leak (#40a).
/// Defensive only — no current row should contain one.
///
/// R12: the detection targets actual path SHAPES, not loose substrings. The
/// old checks wiped legitimate math content: `starts_with('/')` redacted
/// answers like "/3 is the slope", and `contains(":\\")` matched LaTeX like
/// "Evaluate:\[x^2\]". Now: well-known Unix directory roots (including
/// /Volumes/), home-relative prefixes, Windows drive paths (backslash OR
/// forward-slash form) with a real path segment after the drive, and
/// `\Users\` segments. Accepted gap: classic HFS colon paths
/// ("Macintosh HD:Users:jacob") are not detected (see the module docs).
fn looks_like_path(s: &str) -> bool {
    // Well-known Unix roots (leaky: usernames, system layout) — anywhere in
    // the string, since paths get embedded mid-sentence. /Volumes/ covers
    // macOS external and secondary volumes (the bundle is macOS-only).
    const UNIX_ROOTS: &[&str] = &[
        "/Users/", "/home/", "/etc/", "/var/", "/tmp/", "/private/", "/opt/", "/usr/",
        "/Volumes/",
    ];
    if UNIX_ROOTS.iter().any(|p| s.contains(p)) {
        return true;
    }
    // Home-/cwd-relative prefixes.
    if s.starts_with("~/") || s.starts_with("./") || s.starts_with("../") {
        return true;
    }
    // Windows: a `\Users\` segment, or a drive path like `C:\...` / `D:/...`
    // — the drive letter must sit at a word boundary so "Evaluate:\[" (alpha
    // before the colon is part of a WORD, not a drive) never matches.
    if s.contains("\\Users\\") {
        return true;
    }
    has_windows_drive_path(s)
}

/// A single alphabetic drive letter followed by `:\` (or the forward-slash
/// form `:/`), at the start or after a non-alphanumeric boundary, AND
/// followed by a REAL path segment ending in a separator (e.g. "C:\Users\…",
/// "D:/data/notes.txt").
///
/// R12 round 2: the boundary check alone still matched single-letter math
/// identifiers — "Solve for x:\[ x^2-4=0 \]" and "f:\mathbb{R}\to\mathbb{R}"
/// were redacted wholesale. Requiring `[A-Za-z0-9_. -]+` then `\` or `/`
/// after the drive colon makes LaTeX fail fast: `:\[` starts with a bracket
/// (not a segment char) and `:\mathbb{`/`:\frac{` hit `{` before any
/// separator. The deliberate trade-off: a bare separator-less drive string
/// like "c:\data" (indistinguishable in shape from "x:\alpha") is no longer
/// treated as a path.
fn has_windows_drive_path(s: &str) -> bool {
    let b = s.as_bytes();
    (0..b.len().saturating_sub(2)).any(|i| {
        b[i].is_ascii_alphabetic()
            && b[i + 1] == b':'
            && (b[i + 2] == b'\\' || b[i + 2] == b'/')
            && (i == 0 || !b[i - 1].is_ascii_alphanumeric())
            && path_segment_follows(&b[i + 3..])
    })
}

/// True when the bytes begin with a path SEGMENT: one or more segment
/// characters (`[A-Za-z0-9_. -]`) followed immediately by a `\` or `/`
/// separator. LaTeX continuations fail here: `[` is not a segment character,
/// and macro arguments (`{`) arrive before any separator.
fn path_segment_follows(rest: &[u8]) -> bool {
    let seg_len = rest
        .iter()
        .take_while(|&&c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b' ' | b'-'))
        .count();
    seg_len > 0 && matches!(rest.get(seg_len), Some(b'\\') | Some(b'/'))
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
        // Path scrub on the free-text fields (see the module docs for the
        // exact list). error_pattern_detected is grader-emitted free text
        // that can echo a path-bearing user answer verbatim, so it gets the
        // same treatment as user_answer.
        for a in &mut v {
            a.user_answer = scrub(a.user_answer.take());
            a.error_pattern_detected = scrub(a.error_pattern_detected.take());
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

    /// R12: legitimate math/LaTeX content SURVIVES the scrub while real paths
    /// (including mid-sentence ones) are still redacted.
    #[test]
    fn path_detector_spares_latex_and_slash_leading_math() {
        // False positives the old substring checks wiped:
        assert!(!looks_like_path("Evaluate:\\[ \\int_0^1 x^2 \\, dx \\]"), "LaTeX after colon");
        assert!(!looks_like_path("/3 is the slope"), "'/'-leading math answer");
        assert!(!looks_like_path("/ 4 = 0.25"));
        assert!(!looks_like_path("f: \\mathbb{R} \\to \\mathbb{R}"));
        assert!(!looks_like_path("ratio 1/2 or 3/4"));
        assert!(
            !looks_like_path("Simplify:\\frac{1}{2}"),
            "word before ':\\' is not a drive letter"
        );

        // Real paths still caught, embedded or not:
        assert!(looks_like_path("my file is at /Users/alice/notes.txt"));
        assert!(looks_like_path("see C:\\Users\\me\\quiz.txt"));
        assert!(looks_like_path("c:\\data\\notes.txt"));
        assert!(looks_like_path("stored under /home/bob/"));
        assert!(looks_like_path("/var/log/system.log"));
        assert!(looks_like_path("\\\\host\\Users\\me") || looks_like_path("\\Users\\me"));
        assert!(looks_like_path("../secrets.txt"));
        assert!(looks_like_path("~/Desktop/export.json"));
    }

    /// R12 round 2: the exact single-letter-before-':\'' false positives the
    /// first pass left behind now SURVIVE (a drive match requires a real path
    /// segment ending in a separator after the colon), while real drive
    /// paths — including the forward-slash form — and /Volumes/ are caught.
    #[test]
    fn path_detector_spares_single_letter_latex_but_keeps_real_drives() {
        // Single-letter identifier + display math / set notation (reachable
        // today in prompts and answers):
        assert!(!looks_like_path("Solve for x:\\[ x^2-4=0 \\]"), "display math after a variable");
        assert!(!looks_like_path("f:\\mathbb{R}\\to\\mathbb{R}"), "function signature");
        assert!(
            !looks_like_path("Let g:\\mathbb{R}\\to\\mathbb{R} be continuous"),
            "mid-sentence function signature"
        );

        // Real Windows drive paths still redact — backslash and forward-slash
        // forms, at the start or embedded:
        assert!(looks_like_path("C:\\Users\\jacob"));
        assert!(looks_like_path("see D:\\data\\notes.txt"));
        assert!(looks_like_path("D:/data/notes.txt"), "forward-slash drive form");
        assert!(looks_like_path("file:///D:/data/notes.txt"), "file URL drive form");

        // macOS secondary/external volumes:
        assert!(looks_like_path("/Volumes/USB/homework.txt"));

        // Deliberate trade-off: a separator-less drive string has the same
        // shape as a LaTeX macro after a single letter, so it now survives.
        assert!(!looks_like_path("c:\\data"), "separator-less drive is the accepted trade-off");
        // Accepted gap (module docs): classic HFS colon paths pass through.
        assert!(!looks_like_path("Macintosh HD:Users:jacob:Documents:notes.txt"));
    }

    /// error_pattern_detected derives from the same user free text the
    /// user_answer scrub protects — a path echoed into it is redacted, while
    /// an ordinary snake_case pattern survives.
    #[test]
    fn export_scrubs_error_pattern_detected() {
        let conn = db();
        conn.execute(
            "INSERT INTO concepts(id, domain, module, title) VALUES('alg_001','algebra','m1','Intro')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO quiz_answers(concept_id, question_id, question_type, prompt, user_answer, \
             is_correct, error_pattern_detected, created_at) \
             VALUES('alg_001','q1','free_response','p','a',0,'quoted /Users/jacob/hw.txt instead of solving','2026-06-11')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO quiz_answers(concept_id, question_id, question_type, prompt, user_answer, \
             is_correct, error_pattern_detected, created_at) \
             VALUES('alg_001','q2','free_response','p','a',0,'sign_error','2026-06-11')",
            [],
        )
        .unwrap();

        let export = build_export(&conn).unwrap();
        assert_eq!(
            export.quiz_answers[0].error_pattern_detected.as_deref(),
            Some("[redacted path]"),
            "path-bearing grader pattern redacted"
        );
        assert_eq!(
            export.quiz_answers[1].error_pattern_detected.as_deref(),
            Some("sign_error"),
            "ordinary pattern survives"
        );
        let json = serde_json::to_string(&export).unwrap();
        assert!(!json.contains("/Users/jacob/hw.txt"), "path leaked via error pattern");
    }

    /// R12 end-to-end: a LaTeX prompt and a '/'-leading answer survive the
    /// export scrub; a real path in the same table is still redacted.
    #[test]
    fn export_scrub_spares_math_but_redacts_real_paths() {
        let conn = db();
        conn.execute(
            "INSERT INTO concepts(id, domain, module, title) VALUES('alg_001','algebra','m1','Intro')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO quiz_answers(concept_id, question_id, question_type, prompt, user_answer, \
             is_correct, created_at) VALUES('alg_001','q1','free_response','Evaluate:\\[ x^2 \\]','/3 is the slope',1,'2026-06-11')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO quiz_answers(concept_id, question_id, question_type, prompt, user_answer, \
             is_correct, created_at) VALUES('alg_001','q2','free_response','p','/Users/alice/answers.txt',0,'2026-06-11')",
            [],
        )
        .unwrap();

        let export = build_export(&conn).unwrap();
        assert_eq!(
            export.quiz_answers[0].prompt, "Evaluate:\\[ x^2 \\]",
            "LaTeX prompt survives"
        );
        assert_eq!(
            export.quiz_answers[0].user_answer.as_deref(),
            Some("/3 is the slope"),
            "'/'-leading math answer survives"
        );
        assert_eq!(
            export.quiz_answers[1].user_answer.as_deref(),
            Some("[redacted path]"),
            "real path still scrubbed"
        );
    }
}
