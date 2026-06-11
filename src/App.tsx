import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { GamificationProvider } from "./components/GamificationProvider";
import { OnboardingGate } from "./components/OnboardingGate";
import { ToastProvider } from "./components/ui";
import { DashboardPage } from "./pages/DashboardPage";
import { LessonPage } from "./pages/LessonPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { PlacementPage } from "./pages/PlacementPage";
import { QuizPage } from "./pages/QuizPage";
import { ProgressPage } from "./pages/placeholders";
import { SettingsPage } from "./pages/SettingsPage";

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
    </ToastProvider>
  );
}
