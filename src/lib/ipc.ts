import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types/contract";

// Thin typed wrapper over Tauri's invoke. Rust commands return Result<T, String>;
// Tauri rejects the promise on Err. We normalize both branches into IpcResult<T>
// so every caller handles the error branch explicitly (never an empty catch).
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<IpcResult<T>> {
  try {
    const data = await invoke<T>(cmd, args);
    return { ok: true, data };
  } catch (e) {
    const error = typeof e === "string" ? e : e instanceof Error ? e.message : "Unexpected error";
    return { ok: false, error };
  }
}

export const ipc = {
  getSettings: () => call<AppSettings>("get_settings"),
  setSetting: (key: string, value: string) => call<null>("set_setting", { key, value }),
  setApiKey: (key: string) => call<null>("set_api_key", { key }),
  deleteApiKey: () => call<null>("delete_api_key"),
  hasApiKey: () => call<boolean>("has_api_key"),
  testApiKey: () => call<boolean>("test_api_key"),
};
