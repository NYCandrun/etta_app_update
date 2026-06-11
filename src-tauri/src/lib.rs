//! Etta backend library. Milestone 0: foundation only — the contract types,
//! the shared xml_escape util, and the Tauri app wiring. Feature commands land
//! in later milestones.

pub mod contract;
pub mod samples;
pub mod util;

/// Minimal IPC command so the frontend has a verified channel from day one.
/// Returns the app name; used by later milestones' health checks.
#[tauri::command]
fn app_name() -> String {
    "Etta".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![app_name])
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

        // Write to <repo>/src/types/__generated__/contract-fixture.json.
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
