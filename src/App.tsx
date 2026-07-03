import { useEffect } from "react";
import type { ReactNode } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { GamificationProvider } from "./components/GamificationProvider";
import { OnboardingGate } from "./components/OnboardingGate";
import { ToastProvider, useToast } from "./components/ui";
import { ipc } from "./lib/ipc";
import { applyTheme, watchSystemTheme } from "./lib/theme";
import { useSettingsStore } from "./stores/useSettingsStore";
import { DashboardPage } from "./pages/DashboardPage";
import { LessonPage } from "./pages/LessonPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { PlacementPage } from "./pages/PlacementPage";
import { QuizPage } from "./pages/QuizPage";
import { ProgressPage } from "./pages/placeholders";
import { SettingsPage } from "./pages/SettingsPage";

// Hydrates the settings store ONCE at the app root (H6) — a returning user
// gets their saved theme/goal/model on /dashboard without ever visiting
// Settings — and bridges the theme preference to the DOM, keeping "system"
// live with the OS (blocklist #8). The store is the single source of truth
// for the preference; the DOM class and the localStorage boot-cache mirror it
// (both written by applyTheme).
function SettingsBoot({ children }: { children: ReactNode }) {
  const theme = useSettingsStore((s) => s.settings.theme);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const { showError } = useToast();

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void ipc.getSettings().then((res) => {
        if (cancelled) return;
        if (res.ok) setSettings(res.data);
        else showError(`Could not load your settings: ${res.error}`, load);
      });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [setSettings, showError]);

  useEffect(() => {
    applyTheme(theme);
    return watchSystemTheme(theme, () => applyTheme(theme));
  }, [theme]);

  return <>{children}</>;
}

// Use HashRouter only. History-based routing breaks under Tauri's tauri://
// file protocol (blocklist #14); do not switch the router type.
//
// First-run gating lives in <OnboardingGate>: until the backend confirms
// onboarding + placement is complete, every non-onboarding route redirects to
// /onboarding. The gate is inside the router (it reads the current path) and
// leaves /onboarding and /placement ungated so the first-run flow can run.
export function App() {
  return (
    <ToastProvider>
      <SettingsBoot>
        <GamificationProvider>
          <HashRouter>
            <OnboardingGate>
              <Routes>
                <Route path="/onboarding" element={<OnboardingPage />} />
                <Route path="/placement" element={<PlacementPage />} />
                <Route element={<AppLayout />}>
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/lesson/:conceptId" element={<LessonPage />} />
                  <Route path="/quiz/:conceptId" element={<QuizPage />} />
                  <Route path="/progress" element={<ProgressPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                </Route>
                {/* Unknown routes fall through to the dashboard (which the gate
                    will redirect to /onboarding on first run). */}
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </OnboardingGate>
          </HashRouter>
        </GamificationProvider>
      </SettingsBoot>
    </ToastProvider>
  );
}
