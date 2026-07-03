export type ThemePreference = "light" | "dark" | "system";

const DARK_QUERY = "(prefers-color-scheme: dark)";

// Boot-time theme cache. WRITTEN only here (applyTheme); READ only by the
// pre-hydration snippet in index.html, which applies the `dark` class before
// first paint to avoid the white flash. The SQLite settings row stays the
// single source of truth — this key is a cache, never a second authority.
export const THEME_STORAGE_KEY = "etta-theme";

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

// Apply the resolved theme by toggling the `dark` class on <html>, and mirror
// the PREFERENCE (not the resolved value — "system" must keep tracking the OS
// at boot) into localStorage for the index.html pre-hydration snippet.
// Idempotent and side-effect-safe to call at boot and on every change.
export function applyTheme(pref: ThemePreference): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(pref);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Storage unavailable (private mode, disabled): the mirror is only a
    // flash-avoidance cache, so failing silently is correct.
  }
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
