import { useSyncExternalStore } from "react";

// Tracks real network reachability via the browser's online/offline events
// (milestone 5, item #11 / blocklist offline mode). When offline, the app falls
// to review-only mode: every AI-dependent action is DISABLED (not just bannered)
// and cached content is still served. `useSyncExternalStore` keeps the value in
// sync across every consumer without a provider.
//
// `navigator.onLine === false` is authoritative for "definitely offline"; a true
// value can be optimistic (the browser only knows it has *a* network), so the
// real connectivity test ("Test connection" in Settings, and live AI call
// failures) remains the source of truth for "the API is actually reachable".

function subscribe(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getSnapshot(): boolean {
  // Default to online when the API is unavailable (e.g. very old runtimes).
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

// Server snapshot (SSR / tests without a navigator): assume online.
function getServerSnapshot(): boolean {
  return true;
}

/** `true` when the browser reports a network connection, `false` when offline. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
