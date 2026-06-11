import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Skeleton, useToast } from "../components/ui";
import { ipc } from "../lib/ipc";
import { LABELS } from "../lib/labels";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { ThemePreference } from "../lib/theme";

// First-run onboarding (milestone 4): goal selection, daily-time goal, API key
// (→ keychain, with FORMAT validation + inline accessible feedback, NEVER a
// native alert() — blocklist #23), and theme. The store is the single source of
// truth; every IPC failure surfaces a toast + retry (blocklist #16). On finish
// we move to the placement micro-quiz (we do NOT mark onboarding complete here —
// `place_learner` does that once placement succeeds).

const GOALS = [15, 30, 45, 60] as const;
const THEMES: ThemePreference[] = ["light", "dark", "system"];

// The learning goals are informational framing only (they don't change the
// curriculum, which always runs algebra→astrophysics); we persist the chosen
// daily-time goal, which DOES drive the session builder.
const LEARNING_GOALS = [
  { id: "foundations", label: "Rebuild my math foundations" },
  { id: "calculus", label: "Get through calculus" },
  { id: "physics", label: "Reach university physics" },
  { id: "curiosity", label: "Learn for curiosity" },
] as const;

// A plausible Anthropic key shape. We validate FORMAT only here (a real
// connectivity test happens in Settings); the point is to catch obvious paste
// errors with inline, accessible feedback rather than a silent failure later.
function apiKeyFormatError(key: string): string | null {
  const k = key.trim();
  if (k === "") return "Enter your Anthropic API key to continue.";
  if (!k.startsWith("sk-ant-")) return "An Anthropic key starts with “sk-ant-”.";
  if (k.length < 20) return "That key looks too short — check you pasted all of it.";
  return null;
}

type Step = "goal" | "time" | "key" | "theme";
const STEP_ORDER: Step[] = ["goal", "time", "key", "theme"];

export function OnboardingPage() {
  const navigate = useNavigate();
  const { showError } = useToast();
  const settings = useSettingsStore((s) => s.settings);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const setTheme = useSettingsStore((s) => s.setTheme);

  const [step, setStep] = useState<Step>("goal");
  const [learningGoal, setLearningGoal] = useState<string>("foundations");

  // API key local state: the raw input, its inline validation message, and a
  // touched flag so we only show the error after a save attempt / blur.
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState(false);

  // Hydrate settings once so the goal/theme pickers reflect any prior values.
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

  const onChooseGoalMinutes = useCallback(
    async (minutes: number) => {
      setSettings({
        ...settings,
        dailyGoalMinutes: minutes as 15 | 30 | 45 | 60,
      });
      const res = await ipc.setSetting("daily_goal_minutes", String(minutes));
      if (!res.ok) showError(res.error, () => void onChooseGoalMinutes(minutes));
    },
    [settings, setSettings, showError],
  );

  const onChooseTheme = useCallback(
    async (theme: ThemePreference) => {
      setTheme(theme); // applies live
      const res = await ipc.setSetting("theme", theme);
      if (!res.ok) showError(res.error, () => void onChooseTheme(theme));
    },
    [setTheme, showError],
  );

  // Save the API key to the keychain. Validates format inline first; on success
  // refreshes settings (so apiKeyPresent flips) and advances to the theme step.
  const onSaveKey = useCallback(async () => {
    const err = apiKeyFormatError(apiKeyInput);
    if (err) {
      setKeyError(err);
      return;
    }
    setKeyError(null);
    setSavingKey(true);
    const res = await ipc.setApiKey(apiKeyInput.trim());
    setSavingKey(false);
    if (!res.ok) {
      // A backend rejection is shown inline (accessible), not as a native dialog.
      setKeyError(res.error);
      return;
    }
    setApiKeyInput("");
    const refreshed = await ipc.getSettings();
    if (refreshed.ok) setSettings(refreshed.data);
    setStep("theme");
  }, [apiKeyInput, setSettings]);

  const goToPlacement = useCallback(() => {
    navigate("/placement");
  }, [navigate]);

  const stepIndex = STEP_ORDER.indexOf(step);

  if (!hydrated) {
    return (
      <div className="mx-auto flex min-h-full max-w-xl items-center px-4">
        <Card className="w-full">
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center gap-4 px-4 py-8">
      <header className="text-center">
        <h1 className="text-2xl font-semibold text-text">Welcome to Etta</h1>
        <p className="mt-1 text-sm text-text-muted">
          A few quick choices, then a short placement check.
        </p>
        <ol className="mt-3 flex justify-center gap-2" aria-label="Onboarding progress">
          {STEP_ORDER.map((s, i) => (
            <li
              key={s}
              aria-current={s === step ? "step" : undefined}
              className={
                i <= stepIndex
                  ? "h-1.5 w-10 rounded-full bg-primary"
                  : "h-1.5 w-10 rounded-full bg-surface-muted"
              }
            />
          ))}
        </ol>
      </header>

      {step === "goal" && (
        <Card>
          <h2 className="text-base font-semibold text-text">What brings you here?</h2>
          <fieldset className="mt-3 flex flex-col gap-2">
            <legend className="sr-only">Learning goal</legend>
            {LEARNING_GOALS.map((g) => (
              <Button
                key={g.id}
                variant={learningGoal === g.id ? "primary" : "secondary"}
                aria-pressed={learningGoal === g.id}
                className="justify-start"
                onClick={() => setLearningGoal(g.id)}
              >
                {g.label}
              </Button>
            ))}
          </fieldset>
          <div className="mt-5 flex justify-end">
            <Button onClick={() => setStep("time")}>Next</Button>
          </div>
        </Card>
      )}

      {step === "time" && (
        <Card>
          <h2 className="text-base font-semibold text-text">Daily goal</h2>
          <p className="mt-1 text-sm text-text-muted">
            How much time do you want to aim for each day?
          </p>
          <fieldset className="mt-3 flex gap-2">
            <legend className="sr-only">Daily goal in minutes</legend>
            {GOALS.map((g) => (
              <Button
                key={g}
                variant={settings.dailyGoalMinutes === g ? "primary" : "secondary"}
                aria-pressed={settings.dailyGoalMinutes === g}
                onClick={() => void onChooseGoalMinutes(g)}
              >
                {g} min
              </Button>
            ))}
          </fieldset>
          <div className="mt-5 flex justify-between">
            <Button variant="ghost" onClick={() => setStep("goal")}>
              Back
            </Button>
            <Button onClick={() => setStep("key")}>Next</Button>
          </div>
        </Card>
      )}

      {step === "key" && (
        <Card>
          <h2 className="text-base font-semibold text-text">Anthropic API key</h2>
          <p className="mt-1 text-sm text-text-muted">
            Stored only in your OS keychain — never written to disk or the
            database. Etta uses it to generate your lessons and quizzes.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <label htmlFor="onboarding-api-key" className="text-sm font-medium text-text">
              API key
            </label>
            <input
              id="onboarding-api-key"
              type="password"
              autoComplete="off"
              value={apiKeyInput}
              onChange={(e) => {
                setApiKeyInput(e.target.value);
                if (keyError) setKeyError(null);
              }}
              onBlur={() => setKeyError(apiKeyFormatError(apiKeyInput))}
              aria-invalid={keyError ? true : undefined}
              aria-describedby="onboarding-api-key-feedback"
              placeholder="sk-ant-…"
              className="rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-text"
            />
            {/* Inline, accessible feedback (blocklist #23/#34) — never alert(). */}
            <p
              id="onboarding-api-key-feedback"
              role={keyError ? "alert" : undefined}
              aria-live="polite"
              className={keyError ? "text-sm text-danger" : "sr-only"}
            >
              {keyError ?? ""}
            </p>
          </div>
          <div className="mt-5 flex justify-between">
            <Button variant="ghost" onClick={() => setStep("time")}>
              Back
            </Button>
            <Button onClick={() => void onSaveKey()} disabled={savingKey}>
              {savingKey ? "Saving…" : "Save key"}
            </Button>
          </div>
        </Card>
      )}

      {step === "theme" && (
        <Card>
          <h2 className="text-base font-semibold text-text">Theme</h2>
          <p className="mt-1 text-sm text-text-muted">You can change this later in Settings.</p>
          <fieldset className="mt-3 flex gap-2">
            <legend className="sr-only">Theme</legend>
            {THEMES.map((t) => (
              <Button
                key={t}
                variant={settings.theme === t ? "primary" : "secondary"}
                aria-pressed={settings.theme === t}
                onClick={() => void onChooseTheme(t)}
              >
                {t[0]?.toUpperCase() + t.slice(1)}
              </Button>
            ))}
          </fieldset>
          <div className="mt-5 flex justify-between">
            <Button variant="ghost" onClick={() => setStep("key")}>
              Back
            </Button>
            <Button onClick={goToPlacement} disabled={!settings.apiKeyPresent}>
              {LABELS.continue} to placement
            </Button>
          </div>
          {!settings.apiKeyPresent && (
            <p className="mt-2 text-sm text-text-muted" aria-live="polite">
              Add your API key (previous step) to start the placement check.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
