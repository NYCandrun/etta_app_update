import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useSettingsStore } from "./stores/useSettingsStore";
import { applyTheme, watchSystemTheme } from "./lib/theme";
import "./styles/theme.css";

// Bridges the persisted theme preference to the DOM and keeps "system" live
// with the OS (blocklist #8). The store is the single source of truth for the
// preference; this only reflects it.
function ThemeBridge({ children }: { children: React.ReactNode }) {
  const theme = useSettingsStore((s) => s.settings.theme);

  useEffect(() => {
    applyTheme(theme);
    return watchSystemTheme(theme, () => applyTheme(theme));
  }, [theme]);

  return <>{children}</>;
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <ThemeBridge>
      <App />
    </ThemeBridge>
  </StrictMode>,
);
