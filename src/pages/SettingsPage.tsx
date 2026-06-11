import { useEffect, useState } from "react";
import { Button, Card, Spinner, useToast } from "../components/ui";
import { ipc } from "../lib/ipc";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { ThemePreference } from "../lib/theme";

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

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [busy, setBusy] = useState(false);

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
    </div>
  );
}
