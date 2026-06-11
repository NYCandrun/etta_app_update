import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { GamificationProvider } from "./components/GamificationProvider";
import { ToastProvider } from "./components/ui";
import { LessonPage } from "./pages/LessonPage";
import { QuizPage } from "./pages/QuizPage";
import {
  DashboardPage,
  OnboardingPage,
  ProgressPage,
} from "./pages/placeholders";
import { SettingsPage } from "./pages/SettingsPage";

// Use HashRouter only. History-based routing breaks under Tauri's tauri://
// file protocol (blocklist #14); do not switch the router type.
export function App() {
  return (
    <ToastProvider>
      <GamificationProvider>
        <HashRouter>
          <Routes>
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route element={<AppLayout />}>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/lesson/:conceptId" element={<LessonPage />} />
              <Route path="/quiz/:conceptId" element={<QuizPage />} />
              <Route path="/progress" element={<ProgressPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
            {/* App launches to an empty /dashboard. */}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </HashRouter>
      </GamificationProvider>
    </ToastProvider>
  );
}
