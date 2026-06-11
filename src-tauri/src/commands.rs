//! Tauri command surface for the data layer (milestone 1).
//!
//! Every command validates its input (#44), holds the single shared connection
//! from `AppState` behind its Mutex (never opens a new connection), and returns
//! `Result<T, String>` — the frontend wraps both branches into `IpcResult<T>`
//! and always handles the error branch. Generic, user-facing errors only; the
//! detailed cause goes to stderr via `tracing`. The API key is NEVER a command
//! parameter that gets logged except `set_api_key`, whose argument is never
//! logged.

use tauri::State;

use crate::contract::AppSettings;
use crate::db::AppState;
use crate::mastery::{self, MasterySnapshot};
use crate::{cache, export, keychain, settings, validate};

/// Lock the shared connection. A poisoned mutex is an unrecoverable bug, so we
/// surface a generic error rather than panicking across the IPC boundary.
fn conn<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    state
        .db
        .lock()
        .map_err(|_| "internal db lock error".to_string())
}

// ---- Settings ----

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let c = conn(&state)?;
    settings::load_settings(&c)
}

/// Persist one allowlisted, validated setting (string-encoded value). Unknown
/// keys and out-of-range values are rejected (#13).
#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    validate::string_len("setting value", &value, 256)?;
    let c = conn(&state)?;
    settings::set_setting(&c, &key, &value)
}

// ---- API key (keychain only) ----

/// Store the API key in the keychain and set the api_key_present flag. The
/// `key` argument is never logged.
#[tauri::command]
pub fn set_api_key(state: State<'_, AppState>, key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("API key must not be empty".into());
    }
    validate::string_len("api key", &key, 512)?;
    keychain::set_key(&key)?;
    let c = conn(&state)?;
    settings::set_bool(&c, "api_key_present", true)
}

#[tauri::command]
pub fn delete_api_key(state: State<'_, AppState>) -> Result<(), String> {
    keychain::delete_key()?;
    let c = conn(&state)?;
    settings::set_bool(&c, "api_key_present", false)
}

#[tauri::command]
pub fn has_api_key(state: State<'_, AppState>) -> Result<bool, String> {
    let c = conn(&state)?;
    Ok(settings::get_bool(&c, "api_key_present")?.unwrap_or(false))
}

/// Verify the STORED key is present and non-empty. Takes NO key parameter, so
/// the key is never a logged argument (#40). (Network verification lands in a
/// later milestone; this milestone confirms a usable key exists in keychain.)
#[tauri::command]
pub fn test_api_key() -> Result<bool, String> {
    match keychain::get_key()? {
        Some(k) if !k.trim().is_empty() => Ok(true),
        _ => Ok(false),
    }
}

// ---- Content cache ----

#[tauri::command]
pub fn cache_get(
    state: State<'_, AppState>,
    concept_id: String,
    content_type: String,
) -> Result<Option<String>, String> {
    validate::concept_id(&concept_id)?;
    validate::content_type(&content_type)?;
    let c = conn(&state)?;
    Ok(cache::get(&c, &concept_id, &content_type)?.map(|hit| hit.payload_json))
}

#[tauri::command]
pub fn cache_put(
    state: State<'_, AppState>,
    concept_id: String,
    content_type: String,
    payload_json: String,
    mastery_band: Option<String>,
    model_version: Option<String>,
) -> Result<(), String> {
    validate::concept_id(&concept_id)?;
    validate::content_type(&content_type)?;
    validate::string_len("payload_json", &payload_json, 200_000)?;
    let c = conn(&state)?;
    cache::put(
        &c,
        &concept_id,
        &content_type,
        &payload_json,
        mastery_band.as_deref(),
        model_version.as_deref(),
    )
}

// ---- Mastery ----

#[tauri::command]
pub fn get_mastery_history(state: State<'_, AppState>) -> Result<Vec<MasterySnapshot>, String> {
    let c = conn(&state)?;
    mastery::get_mastery_history(&c)
}

#[tauri::command]
pub fn write_mastery_snapshot(
    state: State<'_, AppState>,
    date: String,
    domain: String,
    score: f64,
) -> Result<(), String> {
    validate::string_len("date", &date, 10)?;
    validate::string_len("domain", &domain, 64)?;
    let c = conn(&state)?;
    mastery::write_mastery_snapshot(&c, &date, &domain, score)
}

/// Minimal health-check command kept from milestone 0.
#[tauri::command]
pub fn app_name() -> String {
    "Etta".to_string()
}

// ---- Data export (milestone 5, #14 / #40a) ----

/// Build the complete user-data export as a pretty-printed JSON string. Contains
/// no secrets (the API key lives only in the keychain and is never read here)
/// and no file paths (defensive scrub). The frontend writes this to a file named
/// `etta-export-YYYY-MM-DD.json` via the OS save dialog.
#[tauri::command]
pub fn export_data(state: State<'_, AppState>) -> Result<String, String> {
    let c = conn(&state)?;
    let doc = export::build_export(&c)?;
    serde_json::to_string_pretty(&doc).map_err(|e| {
        tracing::error!(error = %e, "serialize export failed");
        "could not serialize your data export".to_string()
    })
}
