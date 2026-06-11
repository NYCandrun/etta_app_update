//! Etta backend library. Milestone 1: foundation + data layer.
//!
//! - One SQLite connection in `AppState` behind a Mutex (never per-command).
//! - Idempotent schema init, daily backup, cache purge, xp pruning on startup.
//! - Typed settings, keychain API-key storage, content cache, mastery reads.
//! - Structured `tracing` logging; secrets are never logged.

pub mod cache;
pub mod commands;
pub mod contract;
pub mod db;
pub mod keychain;
pub mod mastery;
pub mod samples;
pub mod settings;
pub mod util;
pub mod validate;

use std::sync::Mutex;

use tauri::Manager;

use db::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Structured logging to stderr. Detailed context (DB/file/key-op failures)
    // goes here; user-facing errors stay generic. Never logs secrets.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // App support directory (per-OS). The DB and backups live here.
            let data_dir = app.path().app_data_dir().expect("resolve app data dir");

            let conn = db::open(&data_dir).expect("open + init database");

            // Startup hygiene (best-effort; failures are logged, not fatal).
            if let Err(e) = cache::purge_expired(&conn) {
                tracing::error!(error = %e, "cache purge failed");
            }
            if let Err(e) = mastery::prune_xp_events(&conn) {
                tracing::error!(error = %e, "xp prune failed");
            }
            db::backup_if_stale(&data_dir);

            app.manage(AppState {
                db: Mutex::new(conn),
                data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_name,
            commands::get_settings,
            commands::set_setting,
            commands::set_api_key,
            commands::delete_api_key,
            commands::has_api_key,
            commands::test_api_key,
            commands::cache_get,
            commands::cache_put,
            commands::get_mastery_history,
            commands::write_mastery_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Etta");
}

#[cfg(test)]
mod contract_roundtrip {
    use crate::samples;
    use std::path::PathBuf;

    /// Serialize one sample of every contract type to a JSON fixture that the
    /// TypeScript round-trip test consumes. The TS test asserts the JSON shape
    /// matches the TS interfaces, proving FE/BE agreement (blocklist #12).
    #[test]
    fn writes_contract_fixture() {
        let fixture = samples::fixture();
        let json = serde_json::to_string_pretty(&fixture).expect("serialize fixture");

        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let out_dir = manifest
            .parent()
            .expect("repo root")
            .join("src")
            .join("types")
            .join("__generated__");
        std::fs::create_dir_all(&out_dir).expect("create fixture dir");
        std::fs::write(out_dir.join("contract-fixture.json"), json).expect("write fixture");
    }

    /// Round-trip each sample through serde to guarantee serialize/deserialize
    /// are symmetric on the Rust side.
    #[test]
    fn rust_round_trips_each_type() {
        macro_rules! check {
            ($val:expr) => {{
                let v = $val;
                let json = serde_json::to_string(&v).expect("serialize");
                let back = serde_json::from_str(&json).expect("deserialize");
                assert_eq!(v, back);
            }};
        }
        check!(samples::gamification_state());
        check!(samples::concept());
        check!(samples::question());
        check!(samples::quiz_result());
        check!(samples::daily_session());
        check!(samples::app_settings());
        check!(samples::ipc_ok());
        check!(samples::ipc_err());
    }

    /// The IPC envelope must use a real JSON boolean `ok`, matching the TS
    /// discriminated union.
    #[test]
    fn ipc_envelope_uses_boolean_ok() {
        let ok = serde_json::to_value(samples::ipc_ok()).unwrap();
        assert_eq!(ok["ok"], serde_json::Value::Bool(true));
        assert!(ok.get("data").is_some());

        let err = serde_json::to_value(samples::ipc_err()).unwrap();
        assert_eq!(err["ok"], serde_json::Value::Bool(false));
        assert_eq!(err["error"], serde_json::json!("something failed"));
    }
}
