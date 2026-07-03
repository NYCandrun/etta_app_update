import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/theme.css";

// Settings hydration + the theme bridge live INSIDE <App> (SettingsBoot),
// under the ToastProvider, so hydration failures surface like every other
// IPC error and tests can exercise the whole boot path by rendering <App>.

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
