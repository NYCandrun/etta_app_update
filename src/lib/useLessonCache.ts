import { useEffect, useState } from "react";
import { ipc } from "./ipc";

// Offline coherence (WP3): when the app is OFFLINE, probe the backend content
// cache (ipc.isCached — cheap SQL presence checks, no payload) so CACHED
// lessons stay startable everywhere (the lesson stream replays from cache
// server-side without a network) and uncached ones are disabled with
// consistent messaging. Dashboard CTAs and ConceptList rows consume the SAME
// probe result, so they can never disagree.
//
// Returns:
//   null  — no verdict: either online (no gating needed) or probe in flight
//           (consumers treat "offline + no verdict yet" as not-startable,
//           matching the old always-disabled-offline behavior until the probe
//           lands);
//   Set   — the concept ids with a cached lesson (plain OR personalized
//           "lesson_reinforced" — the backend replays whichever it holds).
export function useCachedLessonIds(
  conceptIds: string[],
  online: boolean,
): ReadonlySet<string> | null {
  const [cached, setCached] = useState<ReadonlySet<string> | null>(null);
  // Stable key so a same-content array from a re-render doesn't re-probe.
  const key = conceptIds.join("|");

  useEffect(() => {
    if (online) {
      setCached(null);
      return;
    }
    let cancelled = false;
    const ids = key === "" ? [] : key.split("|");
    void Promise.all(
      ids.map(async (id) => {
        const [plain, reinforced] = await Promise.all([
          ipc.isCached(id, "lesson"),
          ipc.isCached(id, "lesson_reinforced"),
        ]);
        const hit =
          (plain.ok && plain.data) || (reinforced.ok && reinforced.data);
        return hit ? id : null;
      }),
    ).then((hits) => {
      if (cancelled) return;
      setCached(new Set(hits.filter((h): h is string => h !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [key, online]);

  return online ? null : cached;
}
