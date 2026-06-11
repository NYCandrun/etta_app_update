import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Button, Card, OfflineNotice, Spinner, useToast } from "../components/ui";
import { ipc } from "../lib/ipc";
import { useOnline } from "../lib/useOnline";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { ThemePreference } from "../lib/theme";

// Today's date as YYYY-MM-DD for the export filename (local time).
function todayStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const THEMES: ThemePreference[] = ["light", "dark", "system"];
const GOALS = [15, 30, 45, 60] as const;

// Bare Settings form (milestone 1): API key -> keychain, theme, daily goal.
// The store is the single source of truth; this form reads from and writes
// through it. Every IPC failure surfaces a toast with retry (never swallowed).
export function SettingsPage() {
  const settings = useSettingsStore((s) => s.settings);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const { showError } = useToast();
  const online = useOnline();

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [busy, setBusy] = useState(false);

  const [models, setModels] = useState<string[]>([]);
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [exportState, setExportState] = useState<"idle" | "exporting" | "done">("idle");

  // Load persisted settings once into the store.
  useEffect(() => {
    let active = true;
    const load = () => {
      void ipc.getSettings().then((res) => {
        if (!active) return;
        if (res.ok) setSettings(res.data);
        else showError(res.error, load);
      });
    };
    load();
    return () => {
      active = false;
    };
  }, [setSettings, showError]);

  const onSaveKey = async () => {
    if (!apiKeyInput.trim()) return;
    setBusy(true);
    const res = await ipc.setApiKey(apiKeyInput.trim());
    setBusy(false);
    if (!res.ok) {
      showError(res.error, () => void onSaveKey());
      return;
    }
    setApiKeyInput("");
    const refreshed = await ipc.getSettings();
    if (refreshed.ok) setSettings(refreshed.data);
  };

  const onDeleteKey = async () => {
    setBusy(true);
    const res = await ipc.deleteApiKey();
    setBusy(false);
    if (!res.ok) {
      showError(res.error, () => void onDeleteKey());
      return;
    }
    const refreshed = await ipc.getSettings();
    if (refreshed.ok) setSettings(refreshed.data);
  };

  const onChangeTheme = async (theme: ThemePreference) => {
    setTheme(theme); // applies live; store is source of truth
    const res = await ipc.setSetting("theme", theme);
    if (!res.ok) showError(res.error, () => void onChangeTheme(theme));
  };

  const onChangeGoal = async (minutes: number) => {
    setSettings({ ...settings, dailyGoalMinutes: minutes as 15 | 30 | 45 | 60 });
    const res = await ipc.setSetting("daily_goal_minutes", String(minutes));
    if (!res.ok) showError(res.error, () => void onChangeGoal(minutes));
  };

  // Load the model list for the picker once (cached server-side; no completion
  // request is burned). Falls back to the current hardcoded list on failure.
  useEffect(() => {
    let active = true;
    void ipc.listAvailableModels().then((res) => {
      if (active && res.ok) setModels(res.data);
    });
    return () => {
      active = false;
    };
  }, []);

  const onChangeModel = async (model: string) => {
    setSettings({ ...settings, baseModel: model });
    setTestState("idle");
    const res = await ipc.setSetting("base_model", model);
    if (!res.ok) showError(res.error, () => void onChangeModel(model));
  };

  // Real connectivity test using the CONFIGURED model (a tiny completion).
  const onTestConnection = async () => {
    setTestState("testing");
    const res = await ipc.testConnection();
    if (!res.ok) {
      setTestState("fail");
      showError(res.error, () => void onTestConnection());
      return;
    }
    setTestState(res.data ? "ok" : "fail");
  };

  // Export all learner data to a user-chosen JSON file. The backend produces the
  // complete document (no secrets, no file paths); we just pick a destination and
  // write it. The default filename is etta-export-YYYY-MM-DD.json.
  const onExport = async () => {
    setExportState("exporting");
    const res = await ipc.exportData();
    if (!res.ok) {
      setExportState("idle");
      showError(res.error, () => void onExport());
      return;
    }
    let destination: string | null = null;
    try {
      destination = await save({
        defaultPath: `etta-export-${todayStamp()}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
    } catch (e) {
      setExportState("idle");
      showError(e instanceof Error ? e.message : "Could not open the save dialog", () =>
        void onExport(),
      );
      return;
    }
    if (!destination) {
      // User cancelled the save dialog — not an error.
      setExportState("idle");
      return;
    }
    try {
      await writeTextFile(destination, res.data);
      setExportState("done");
    } catch (e) {
      setExportState("idle");
      showError(e instanceof Error ? e.message : "Could not write the export file", () =>
        void onExport(),
      );
    }
  };

  if (!hydrated) {
    return (
      <Card>
        <Spinner label="Loading settings" />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <h1 className="text-xl font-semibold text-text">Settings</h1>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-text">Anthropic API key</h2>
        <p className="mt-1 text-sm text-text-muted">
          Stored only in your OS keychain — never written to disk or the database.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor="api-key" className="text-sm font-medium text-text">
            API key
          </label>
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder={settings.apiKeyPresent ? "•••••••• (a key is set)" : "sk-ant-…"}
            className="rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-text"
          />
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => void onSaveKey()} disabled={busy || !apiKeyInput.trim()}>
              Save key
            </Button>
            <Button
              variant="danger"
              onClick={() => void onDeleteKey()}
              disabled={busy || !settings.apiKeyPresent}
            >
              Remove key
            </Button>
            <span className="text-sm text-text-muted">
              {settings.apiKeyPresent ? "Key present" : "No key set"}
            </span>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-text">Model</h2>
        <p className="mt-1 text-sm text-text-muted">
          The single model used for every AI request. The list comes from your
          account; the connection test uses this same model.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor="base-model" className="text-sm font-medium text-text">
            Base model
          </label>
          <select
            id="base-model"
            value={settings.baseModel}
            onChange={(e) => void onChangeModel(e.target.value)}
            className="rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-text"
          >
            {/* Always include the current value so the select is never empty. */}
            {(models.includes(settings.baseModel)
              ? models
              : [settings.baseModel, ...models]
            ).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => void onTestConnection()}
              disabled={testState === "testing" || !settings.apiKeyPresent || !online}
              aria-disabled={!online}
              title={!online ? "Unavailable while offline" : undefined}
            >
              {testState === "testing" ? "Testing…" : "Test connection"}
            </Button>
            <span className="text-sm text-text-muted">
              {!online
                ? "Offline — reconnect to test"
                : testState === "ok"
                  ? "Connected"
                  : testState === "fail"
                    ? "Connection failed"
                    : !settings.apiKeyPresent
                      ? "Set an API key first"
                      : ""}
            </span>
          </div>
          {!online && <OfflineNotice className="mt-3" />}
        </div>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-text">Theme</h2>
        <fieldset className="mt-3 flex gap-2">
          <legend className="sr-only">Theme</legend>
          {THEMES.map((t) => (
            <Button
              key={t}
              variant={settings.theme === t ? "primary" : "secondary"}
              aria-pressed={settings.theme === t}
              onClick={() => void onChangeTheme(t)}
            >
              {t[0]?.toUpperCase() + t.slice(1)}
            </Button>
          ))}
        </fieldset>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-text">Daily goal</h2>
        <fieldset className="mt-3 flex gap-2">
          <legend className="sr-only">Daily goal in minutes</legend>
          {GOALS.map((g) => (
            <Button
              key={g}
              variant={settings.dailyGoalMinutes === g ? "primary" : "secondary"}
              aria-pressed={settings.dailyGoalMinutes === g}
              onClick={() => void onChangeGoal(g)}
            >
              {g} min
            </Button>
          ))}
        </fieldset>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-text">Your data</h2>
        <p className="mt-1 text-sm text-text-muted">
          Export a complete copy of your progress, quiz history, and settings as
          a JSON file. Your API key is never included.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => void onExport()}
            disabled={exportState === "exporting"}
          >
            {exportState === "exporting" ? "Exporting…" : "Export data"}
          </Button>
          <span className="text-sm text-text-muted" aria-live="polite">
            {exportState === "done" ? "Export saved" : ""}
          </span>
        </div>
      </Card>
    </div>
  );
}
