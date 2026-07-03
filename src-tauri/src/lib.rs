//! Etta backend library. Milestone 1: foundation + data layer.
//!
//! - One SQLite connection in `AppState` behind a Mutex (never per-command).
//! - Idempotent schema init, WAL-safe daily backup, cache purge on startup.
//! - Typed settings, keychain API-key storage, content cache, mastery reads.
//! - Structured `tracing` logging; secrets are never logged.

pub mod adaptive;
pub mod ai;
pub mod cache;
pub mod commands;
pub mod commands_ai;
pub mod commands_m3;
pub mod commands_placement;
pub mod contract;
pub mod curriculum;
pub mod db;
pub mod export;
pub mod gamification;
pub mod grading;
pub mod keychain;
pub mod samples;
pub mod settings;
pub mod util;
pub mod validate;

use std::sync::Mutex;

use tauri::Manager;

use ai::AiState;
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

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // Auto-updater (ship item #16). Registered on desktop; the actual update
    // endpoint + signing pubkey live in tauri.conf.json's `plugins.updater`.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|app| {
            // App support directory (per-OS). The DB and backups live here.
            let data_dir = app.path().app_data_dir().expect("resolve app data dir");

            let conn = db::open(&data_dir).expect("open + init database");

            // Startup hygiene (best-effort; failures are logged, not fatal).
            // NOTE: xp_events is deliberately NEVER pruned — the ledger is both
            // the XP total (SUM over all rows) and the lesson/quiz one-shot
            // award guard, and it is structurally bounded (at most two award
            // rows per concept), so pruning would shrink the displayed total
            // and re-open XP farming (H18).
            if let Err(e) = cache::purge_expired(&conn) {
                tracing::error!(error = %e, "cache purge failed");
            }
            db::backup_if_stale(&conn, &data_dir);

            // Load the bundled curriculum into the `concepts` table (first launch
            // and on a version bump). Validation (DAG, ids, required fields) is a
            // HARD FAIL — a broken curriculum must not ship silently.
            if let Err(e) = curriculum::load_into_db(&conn) {
                panic!("curriculum load failed: {e}");
            }

            // The single shared HTTP client + rate limiter + model cache, built
            // once and managed for the app lifetime (never one client per call).
            let ai_state = AiState::new().expect("build AI state");

            app.manage(AppState {
                db: Mutex::new(conn),
                data_dir,
            });
            app.manage(ai_state);
            // Graded-but-unpersisted quiz results awaiting a persist retry
            // (server-held; the retry never accepts answers from the webview).
            app.manage(commands_m3::PendingPersists::default());
            // In-flight stream cancellation registry (requestId → flag),
            // driven by generate_streamed / cancel_stream (H7).
            app.manage(commands_ai::ActiveStreams::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_name,
            commands::get_settings,
            commands::set_setting,
            commands::set_api_key,
            commands::delete_api_key,
            commands::is_cached,
            commands::export_data,
            commands_ai::list_available_models,
            commands_ai::refresh_available_models,
            commands_ai::initialize_default_model,
            commands_ai::test_connection,
            commands_ai::generate_streamed,
            commands_ai::cancel_stream,
            commands_ai::generate_quiz,
            commands_ai::grade_and_record_quiz,
            commands_m3::get_gamification_state,
            commands_m3::award_lesson_xp,
            commands_m3::retry_persist,
            commands_m3::build_session,
            commands_m3::get_concept_states,
            commands_m3::add_study_minutes,
            commands_m3::get_daily_progress,
            commands_placement::generate_placement_quiz,
            commands_placement::place_learner,
            commands_placement::skip_placement,
            commands_placement::get_onboarding_complete,
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
        check!(samples::wire_question());
        check!(samples::quiz_payload());
        check!(samples::answer_submission());
        check!(samples::quiz_outcome());
        check!(samples::daily_session());
        check!(samples::daily_progress());
        check!(samples::placement_result());
        check!(samples::app_settings());
    }
}
