import { useEffect } from "react";
import { useToast } from "./ui";
import { useDailyProgressStore } from "../stores/useDailyProgressStore";
import { useGamificationStore } from "../stores/useGamificationStore";

// Compact XP / streak / daily-goal-ring cluster shown in the app shell header.
// XP and streak come from the shared gamification store (one fetch at launch,
// blocklist #26). The ring reflects REAL tracked study minutes from the DB
// (blocklist H1) — never a hardcoded 40%/100% — read from the SHARED
// daily-progress store (H12), so the header instance and the dashboard
// instance always agree. Mounting refreshes the store (deduped in-flight);
// study-minute flushes refresh it too, so the ring advances live. On fetch
// failure the ring hides gracefully (one toast per streak, from the store).
export function ProgressIndicators() {
  const gam = useGamificationStore((s) => s.state);
  const progress = useDailyProgressStore((s) => s.progress);
  const refresh = useDailyProgressStore((s) => s.refresh);
  const { showError } = useToast();

  useEffect(() => {
    void refresh(showError);
  }, [refresh, showError]);

  const minutesToday = progress?.minutesToday ?? null;
  const goalMinutes = progress?.goalMinutes ?? 0;
  const ratio =
    minutesToday === null || goalMinutes <= 0
      ? 0
      : Math.min(1, minutesToday / goalMinutes);

  return (
    <div className="flex items-center gap-4 text-sm">
      {/* XP and streak are non-critical detail: hidden on small screens (#38),
          where the daily-goal ring (the primary at-a-glance signal) remains.
          aria-label on a role-less <span> is ignored by most screen readers,
          so the accessible wording is real (visually-hidden) text instead. */}
      <span className="hidden font-medium text-text sm:inline">
        {gam?.xp ?? 0} XP<span className="sr-only"> total</span>
      </span>
      <span className="hidden text-text-muted sm:inline">
        <span aria-hidden="true">🔥</span> {gam?.streak.currentStreak ?? 0}
        <span className="sr-only">
          {" "}
          day streak
        </span>
      </span>
      {/* Hide (don't fake) the ring until real minutes are known — a fetch
          failure must not render a lying 0% ring (H12). */}
      {progress !== null && (
        <DailyGoalRing
          ratio={ratio}
          minutesToday={minutesToday ?? 0}
          goalMinutes={goalMinutes}
        />
      )}
    </div>
  );
}

// A small SVG ring whose fill is the real minutes/goal ratio.
function DailyGoalRing({
  ratio,
  minutesToday,
  goalMinutes,
}: {
  ratio: number;
  minutesToday: number;
  goalMinutes: number;
}) {
  const size = 28;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * ratio;
  const pct = goalMinutes > 0 ? Math.round((minutesToday / goalMinutes) * 100) : 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-valuenow={minutesToday}
      aria-valuemin={0}
      aria-valuemax={goalMinutes}
      aria-label={`Daily goal: ${minutesToday} of ${goalMinutes} minutes (${pct}%)`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgb(var(--color-surface-muted))"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgb(var(--color-primary))"
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
