import { useEffect } from "react";
import type { ReactNode } from "react";
import { ipc } from "../lib/ipc";
import { useToast } from "./ui";
import { useGamificationStore } from "../stores/useGamificationStore";

// Fetches the shared gamification snapshot ONCE at launch and mirrors it into
// the store (blocklist #26: the TopBar/Sidebar/Dashboard must NOT each fetch
// independently). Every later XP grant returns a refreshed snapshot that
// callers push into the same store via `setState` — there is never a local
// increment of XP alongside the backend value (blocklist #1).
export function GamificationProvider({ children }: { children: ReactNode }) {
  const setState = useGamificationStore((s) => s.setState);
  const { showError } = useToast();

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void ipc.getGamificationState().then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setState(res.data);
        } else {
          showError(`Could not load progress: ${res.error}`, load);
        }
      });
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [setState, showError]);

  return <>{children}</>;
}
