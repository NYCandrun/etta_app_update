//! Typed settings accessors over the `settings(key, value)` table.
//!
//! v1's bug (#6): everything was coerced to strings, so `daily_goal=30` read
//! back as the string "30". Here each key has a declared type and a validated
//! range; `daily_goal_minutes` round-trips as the integer 30. Only allowlisted
//! user-facing keys (Appendix B) are accepted; unknown keys are rejected.

use rusqlite::{params, Connection, OptionalExtension};

use crate::contract::AppSettings;

/// The hard allowlist of user-facing settings keys (Appendix B). Any key not on
/// this list is rejected by both the getter and setter (blocklist #13).
pub const ALLOWED_KEYS: &[&str] = &[
    "daily_goal_minutes",
    "theme",
    "base_model",
    "reasoning_model",
    "api_key_present",
    "notifications_enabled",
    "new_concepts_per_session",
];

fn ensure_allowed(key: &str) -> Result<(), String> {
    if ALLOWED_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(format!("unknown setting key: {key}"))
    }
}

/// Raw read of a setting value (the stored TEXT), or None if unset. Allowlisted
/// keys only. This is the single low-level accessor the typed helpers build on.
fn get_raw(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    ensure_allowed(key)?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1 LIMIT 1",
        [key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| crate::util::internal_error("read your settings", e))
}

/// Raw write of a setting value (as TEXT). Allowlisted keys only.
fn set_raw(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    ensure_allowed(key)?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .map_err(|e| crate::util::internal_error("save your settings", e))?;
    Ok(())
}

// ---- Typed helpers ----

pub fn get_i64(conn: &Connection, key: &str) -> Result<Option<i64>, String> {
    match get_raw(conn, key)? {
        Some(s) => s
            .parse::<i64>()
            .map(Some)
            .map_err(|_| format!("setting {key} is not an integer: {s:?}")),
        None => Ok(None),
    }
}

pub fn set_i64(conn: &Connection, key: &str, value: i64) -> Result<(), String> {
    set_raw(conn, key, &value.to_string())
}

pub fn get_bool(conn: &Connection, key: &str) -> Result<Option<bool>, String> {
    match get_raw(conn, key)? {
        Some(s) => match s.as_str() {
            "true" => Ok(Some(true)),
            "false" => Ok(Some(false)),
            other => Err(format!("setting {key} is not a bool: {other:?}")),
        },
        None => Ok(None),
    }
}

pub fn set_bool(conn: &Connection, key: &str, value: bool) -> Result<(), String> {
    set_raw(conn, key, if value { "true" } else { "false" })
}

pub fn get_string(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    get_raw(conn, key)
}

pub fn set_string(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    set_raw(conn, key, value)
}

// ---- Whole-struct accessors (used by the Settings form) ----

const VALID_THEMES: &[&str] = &["light", "dark", "system"];
const VALID_GOALS: &[i64] = &[15, 30, 45, 60];

/// Validate one setting against the contract's allowed values. Centralized so
/// both `set_setting` and `save_settings` reject out-of-range input.
pub fn validate(key: &str, raw: &str) -> Result<(), String> {
    match key {
        "daily_goal_minutes" => {
            let n: i64 = raw
                .parse()
                .map_err(|_| "daily_goal_minutes must be an int")?;
            if !VALID_GOALS.contains(&n) {
                return Err("daily_goal_minutes must be one of 15/30/45/60".into());
            }
        }
        "theme" => {
            if !VALID_THEMES.contains(&raw) {
                return Err("theme must be light|dark|system".into());
            }
        }
        "new_concepts_per_session" => {
            let n: i64 = raw
                .parse()
                .map_err(|_| "new_concepts_per_session must be an int")?;
            if !(1..=10).contains(&n) {
                return Err("new_concepts_per_session must be 1..=10".into());
            }
        }
        "notifications_enabled" | "api_key_present" => {
            if raw != "true" && raw != "false" {
                return Err(format!("{key} must be true|false"));
            }
        }
        "base_model" | "reasoning_model" => {
            if raw.is_empty() || raw.len() > 128 {
                return Err(format!("{key} must be 1..=128 chars"));
            }
        }
        other => return Err(format!("unknown setting key: {other}")),
    }
    Ok(())
}

/// Defaults used when a setting has never been written (first launch).
fn default_for(key: &str) -> &'static str {
    match key {
        "daily_goal_minutes" => "30",
        "theme" => "system",
        "base_model" => "claude-sonnet-4-6",
        "reasoning_model" => "claude-opus-4-8",
        "new_concepts_per_session" => "3",
        "notifications_enabled" => "false",
        "api_key_present" => "false",
        _ => "",
    }
}

/// Read the full `AppSettings` mirror, filling unset keys with defaults.
pub fn load_settings(conn: &Connection) -> Result<AppSettings, String> {
    let daily_goal_minutes = daily_goal_minutes(conn)?;
    let theme = get_string(conn, "theme")?.unwrap_or_else(|| default_for("theme").into());
    let base_model = base_model(conn)?;
    let reasoning_model = get_string(conn, "reasoning_model")?
        .unwrap_or_else(|| default_for("reasoning_model").into());
    let new_concepts_per_session = new_concepts_per_session(conn)?;
    let notifications_enabled = get_bool(conn, "notifications_enabled")?.unwrap_or(false);
    let api_key_present = get_bool(conn, "api_key_present")?.unwrap_or(false);

    Ok(AppSettings {
        daily_goal_minutes,
        theme,
        base_model,
        reasoning_model,
        new_concepts_per_session,
        notifications_enabled,
        api_key_present,
    })
}

/// Set one allowlisted, validated setting from a string-encoded value. The
/// generic command surface goes through here so validation is never bypassed.
///
/// `api_key_present` is DERIVED state (it mirrors whether a key exists in the
/// keychain) managed exclusively by `set_api_key` / `delete_api_key` — the
/// generic surface rejects it so the flag can never be flipped out from under
/// the keychain (R14a). It stays on `ALLOWED_KEYS` because READS (and the
/// internal `set_bool` in the key commands) still go through the allowlist.
pub fn set_setting(conn: &Connection, key: &str, raw: &str) -> Result<(), String> {
    if key == "api_key_present" {
        return Err("api_key_present is managed automatically and cannot be set directly".into());
    }
    ensure_allowed(key)?;
    validate(key, raw)?;
    set_raw(conn, key, raw)
}

/// The configured base model for every AI call. There is exactly ONE source of
/// truth (this accessor) — no call site hardcodes a model id (blocklist #2).
/// Falls back to the contract default ("claude-sonnet-4-6") only when unset;
/// the default is the current June-2026 id, never a stale dated id.
pub fn base_model(conn: &Connection) -> Result<String, String> {
    Ok(get_string(conn, "base_model")?.unwrap_or_else(|| default_for("base_model").into()))
}

/// The daily goal in minutes, defaulted from the ONE defaults table
/// (`default_for`) — call sites never repeat the literal fallback.
pub fn daily_goal_minutes(conn: &Connection) -> Result<i64, String> {
    Ok(get_i64(conn, "daily_goal_minutes")?
        .unwrap_or_else(|| default_for("daily_goal_minutes").parse().unwrap()))
}

/// New concepts per session, defaulted from the ONE defaults table.
pub fn new_concepts_per_session(conn: &Connection) -> Result<i64, String> {
    Ok(get_i64(conn, "new_concepts_per_session")?
        .unwrap_or_else(|| default_for("new_concepts_per_session").parse().unwrap()))
}

// ---- Internal (non-user-facing) state in the settings table ----
//
// The curriculum loader records which CURRICULUM_VERSION has been imported so
// it re-imports only on a version bump. This is internal bookkeeping, NOT a
// user-facing setting, so it lives under a reserved key that is deliberately
// not on `ALLOWED_KEYS` and is read/written through these dedicated accessors
// (never the generic `set_setting` command surface).
const CURRICULUM_VERSION_KEY: &str = "__curriculum_version";

pub fn get_curriculum_version(conn: &Connection) -> Result<Option<i64>, String> {
    match get_reserved(conn, CURRICULUM_VERSION_KEY)? {
        Some(s) => s
            .parse::<i64>()
            .map(Some)
            .map_err(|_| format!("curriculum version is not an integer: {s:?}")),
        None => Ok(None),
    }
}

pub fn set_curriculum_version(conn: &Connection, version: i64) -> Result<(), String> {
    set_reserved(conn, CURRICULUM_VERSION_KEY, &version.to_string())
}

/// Generic reserved-key read/write/delete — the ONE place reserved-key SQL
/// lives (the `__`-prefixed internal keys are NOT on `ALLOWED_KEYS` and never
/// reach the generic `set_setting` command surface). `pub(crate)` so other
/// modules with reserved state (e.g. the streak) share it instead of
/// duplicating the SQL.
pub(crate) fn get_reserved(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1 LIMIT 1",
        [key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| crate::util::internal_error("read internal app state", e))
}

pub(crate) fn set_reserved(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| crate::util::internal_error("save internal app state", e))?;
    Ok(())
}

pub(crate) fn delete_reserved(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])
        .map_err(|e| crate::util::internal_error("clear internal app state", e))?;
    Ok(())
}

// Onboarding completion is internal app state (gates first-run routing), not a
// user-facing preference — it lives under a reserved key.
const ONBOARDING_COMPLETE_KEY: &str = "__onboarding_complete";

pub fn get_onboarding_complete(conn: &Connection) -> Result<bool, String> {
    Ok(get_reserved(conn, ONBOARDING_COMPLETE_KEY)?.as_deref() == Some("true"))
}

pub fn set_onboarding_complete(conn: &Connection, done: bool) -> Result<(), String> {
    set_reserved(
        conn,
        ONBOARDING_COMPLETE_KEY,
        if done { "true" } else { "false" },
    )
}

// The canonical placement-quiz JSON is held server-side between generate and
// grade so the frontend never supplies correctness (server-authoritative).
const PLACEMENT_QUIZ_KEY: &str = "__placement_quiz";

/// Read the stored placement quiz. "Cleared" is the row being ABSENT; an empty
/// or blank value (a legacy "" sentinel from older builds) also reads as None
/// so it can never be mistaken for a stored quiz.
pub fn get_placement_quiz(conn: &Connection) -> Result<Option<String>, String> {
    Ok(get_reserved(conn, PLACEMENT_QUIZ_KEY)?.filter(|s| !s.trim().is_empty()))
}

pub fn set_placement_quiz(conn: &Connection, json: &str) -> Result<(), String> {
    set_reserved(conn, PLACEMENT_QUIZ_KEY, json)
}

/// Clear the one-shot placement quiz by DELETING the row — never by writing an
/// empty-string sentinel.
pub fn clear_placement_quiz(conn: &Connection) -> Result<(), String> {
    delete_reserved(conn, PLACEMENT_QUIZ_KEY)
}

// Placement-seeded concept ids (JSON array under a reserved key). These rows
// were marked mastered by a PLACEMENT DECISION, not by real attempts: the
// session builder keeps them out of the new/review queues and the decay model
// exempts them from forgetting until the learner genuinely attempts them (H16).
const PLACEMENT_SEEDED_KEY: &str = "__placement_seeded";

pub fn get_placement_seeded(
    conn: &Connection,
) -> Result<std::collections::HashSet<String>, String> {
    match get_reserved(conn, PLACEMENT_SEEDED_KEY)? {
        Some(raw) => serde_json::from_str(&raw)
            .map_err(|e| crate::util::internal_error("read placement state", e)),
        None => Ok(Default::default()),
    }
}

/// Merge `ids` into the placement-seeded set (stored sorted for determinism).
pub fn add_placement_seeded(conn: &Connection, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut set = get_placement_seeded(conn)?;
    set.extend(ids.iter().cloned());
    let mut sorted: Vec<&String> = set.iter().collect();
    sorted.sort();
    let json = serde_json::to_string(&sorted)
        .map_err(|e| crate::util::internal_error("save placement state", e))?;
    set_reserved(conn, PLACEMENT_SEEDED_KEY, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&conn).unwrap();
        conn
    }

    /// daily_goal_minutes=30 reads back the INTEGER 30, not the string "30".
    #[test]
    fn daily_goal_round_trips_as_integer() {
        let conn = db();
        set_setting(&conn, "daily_goal_minutes", "30").unwrap();
        let n: Option<i64> = get_i64(&conn, "daily_goal_minutes").unwrap();
        assert_eq!(n, Some(30i64));
    }

    #[test]
    fn unknown_key_is_rejected() {
        let conn = db();
        assert!(set_setting(&conn, "evil_key", "x").is_err());
        assert!(get_string(&conn, "evil_key").is_err());
    }

    #[test]
    fn out_of_range_goal_rejected() {
        let conn = db();
        assert!(set_setting(&conn, "daily_goal_minutes", "31").is_err());
        assert!(set_setting(&conn, "theme", "neon").is_err());
    }

    /// R14a: the derived api_key_present flag cannot be flipped through the
    /// generic setter — only the key commands (via set_bool) manage it, and
    /// reads keep working.
    #[test]
    fn api_key_present_rejected_by_generic_setter_but_readable() {
        let conn = db();
        let err = set_setting(&conn, "api_key_present", "true").unwrap_err();
        assert!(err.contains("managed automatically"), "got: {err}");
        assert_eq!(get_bool(&conn, "api_key_present").unwrap(), None);

        // The key commands' internal path still works.
        set_bool(&conn, "api_key_present", true).unwrap();
        assert_eq!(get_bool(&conn, "api_key_present").unwrap(), Some(true));
        let s = load_settings(&conn).unwrap();
        assert!(s.api_key_present);
    }

    /// Clearing the placement quiz DELETES the row; both the deleted state and
    /// a legacy "" sentinel read back as None (never as a stored quiz).
    #[test]
    fn placement_quiz_clears_by_delete_and_empty_sentinel_reads_none() {
        let conn = db();
        set_placement_quiz(&conn, r#"[{"q":1}]"#).unwrap();
        assert!(get_placement_quiz(&conn).unwrap().is_some());

        clear_placement_quiz(&conn).unwrap();
        assert_eq!(get_placement_quiz(&conn).unwrap(), None);
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key = '__placement_quiz'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0, "cleared = row absent, not an empty sentinel");

        // A legacy "" sentinel left by an older build must also read as None.
        set_placement_quiz(&conn, "").unwrap();
        assert_eq!(get_placement_quiz(&conn).unwrap(), None);
    }

    #[test]
    fn placement_seeded_set_accumulates_and_round_trips() {
        let conn = db();
        assert!(get_placement_seeded(&conn).unwrap().is_empty());
        add_placement_seeded(&conn, &["alg_002".into(), "alg_001".into()]).unwrap();
        add_placement_seeded(&conn, &["alg_002".into(), "prec_001".into()]).unwrap();
        let set = get_placement_seeded(&conn).unwrap();
        assert_eq!(set.len(), 3);
        assert!(set.contains("alg_001") && set.contains("prec_001"));
    }

    #[test]
    fn load_settings_uses_defaults_then_reflects_writes() {
        let conn = db();
        let s = load_settings(&conn).unwrap();
        assert_eq!(s.daily_goal_minutes, 30);
        assert_eq!(s.theme, "system");

        set_setting(&conn, "daily_goal_minutes", "45").unwrap();
        set_setting(&conn, "theme", "dark").unwrap();
        let s = load_settings(&conn).unwrap();
        assert_eq!(s.daily_goal_minutes, 45);
        assert_eq!(s.theme, "dark");
    }
}
