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
use crate::{cache, export, keychain, settings, validate};

// ---- Settings ----

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let c = state.conn()?;
    settings::load_settings(&c)
}

/// Persist one allowlisted, validated setting (string-encoded value). Unknown
/// keys and out-of-range values are rejected (#13).
#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    validate::string_len("setting value", &value, 256)?;
    let c = state.conn()?;
    settings::set_setting(&c, &key, &value)
}

// ---- API key (keychain only) ----

/// Store the API key in the keychain and set the api_key_present flag. The
/// `key` argument is never logged.
///
/// Ordering (R14a): keychain FIRST, then the derived flag. If the flag write
/// fails, the keychain write is rolled back (restore the previous key, or
/// delete if there was none) so key material and flag never disagree. The
/// rollback is best-effort — a rollback failure is logged, and the command
/// still returns the original error.
#[tauri::command]
pub fn set_api_key(state: State<'_, AppState>, key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("API key must not be empty".into());
    }
    validate::string_len("api key", &key, 512)?;
    // Snapshot for rollback (best-effort; an unreadable keychain will fail
    // the set below anyway).
    let previous = keychain::get_key().unwrap_or(None);
    keychain::set_key(&key)?;
    let flag = (|| {
        let c = state.conn()?;
        settings::set_bool(&c, "api_key_present", true)
    })();
    if let Err(e) = flag {
        let rollback = match previous.as_deref() {
            Some(old) => keychain::set_key(old),
            None => keychain::delete_key(),
        };
        if let Err(rb) = rollback {
            tracing::error!(error = %rb, "keychain rollback after flag-write failure also failed");
        }
        return Err(e);
    }
    Ok(())
}

/// Remove the key: keychain first, then the derived flag (R14a). If the flag
/// write fails, the previous key is restored (best-effort) so a true flag
/// never points at an empty keychain.
#[tauri::command]
pub fn delete_api_key(state: State<'_, AppState>) -> Result<(), String> {
    let previous = keychain::get_key().unwrap_or(None);
    keychain::delete_key()?;
    let flag = (|| {
        let c = state.conn()?;
        settings::set_bool(&c, "api_key_present", false)
    })();
    if let Err(e) = flag {
        if let Some(old) = previous.as_deref() {
            if let Err(rb) = keychain::set_key(old) {
                tracing::error!(error = %rb, "keychain restore after flag-write failure failed");
            }
        }
        return Err(e);
    }
    Ok(())
}

// ---- Content cache ----

/// Cheap cache-presence probe for offline UX: does a fresh, valid cached
/// payload exist for (concept_id, content_type)? Read-only, no model call, no
/// payload transfer — the frontend uses it to mark content as available
/// offline.
#[tauri::command]
pub fn is_cached(
    state: State<'_, AppState>,
    concept_id: String,
    content_type: String,
) -> Result<bool, String> {
    validate::concept_id(&concept_id)?;
    validate::content_type(&content_type)?;
    let c = state.conn()?;
    Ok(cache::get(&c, &concept_id, &content_type)?.is_some())
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
    let c = state.conn()?;
    let doc = export::build_export(&c)?;
    serde_json::to_string_pretty(&doc).map_err(|e| {
        tracing::error!(error = %e, "serialize export failed");
        "could not serialize your data export".to_string()
    })
}
