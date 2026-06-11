export type ThemePreference = "light" | "dark" | "system";

const DARK_QUERY = "(prefers-color-scheme: dark)";

// Resolve a stored preference to the concrete theme that should be applied.
export function resolveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref === "system") {
    return typeof window !== "undefined" &&
      window.matchMedia(DARK_QUERY).matches
      ? "dark"
      : "light";
  }
  return pref;
}

// Apply the resolved theme by toggling the `dark` class on <html>.
export function applyTheme(pref: ThemePreference): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(pref);
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

// Subscribe to live OS theme changes; only meaningful when preference is
// "system" (blocklist #8). Returns an unsubscribe fn. Caller re-invokes with
// the current preference whenever it changes.
export function watchSystemTheme(
  pref: ThemePreference,
  onChange: () => void,
): () => void {
  if (typeof window === "undefined" || pref !== "system") {
    return () => {};
  }
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
