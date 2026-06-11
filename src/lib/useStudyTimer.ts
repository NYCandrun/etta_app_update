import { useEffect, useRef } from "react";
import { ipc } from "./ipc";

// Track real study time on a learning screen and persist it (blocklist #25/H1:
// the daily-goal ring reads REAL tracked minutes, never a hardcoded percentage).
//
// We record wall-clock time the screen was mounted and flush the whole-minute
// total to the backend on unmount. Whole minutes only (the backend stores
// minutes); sub-minute visits round down and are dropped, which is fine for a
// daily-goal ring. The flush is fire-and-forget — a tracking failure must never
// block navigation, but we still surface nothing silently swallowed beyond logs.
export function useStudyTimer() {
  const startedAt = useRef<number>(Date.now());

  useEffect(() => {
    const start = Date.now();
    startedAt.current = start;
    return () => {
      const minutes = Math.floor((Date.now() - start) / 60_000);
      if (minutes > 0) {
        void ipc.addStudyMinutes(minutes);
      }
    };
  }, []);
}
