import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import { useGamificationStore } from "../stores/useGamificationStore";

// Compact XP / streak / daily-goal-ring cluster shown in the app shell header.
// XP and streak come from the shared gamification store (one fetch at launch,
// blocklist #26). The ring reflects REAL tracked study minutes from the DB
// (blocklist H1) — never a hardcoded 40%/100%.
export function ProgressIndicators() {
  const gam = useGamificationStore((s) => s.state);
  const [minutesToday, setMinutesToday] = useState<number | null>(null);
  const [goalMinutes, setGoalMinutes] = useState<number>(30);

  useEffect(() => {
    let cancelled = false;
    void ipc.getDailyProgress().then((res) => {
      if (cancelled || !res.ok) return;
      setMinutesToday(res.data.minutesToday);
      setGoalMinutes(res.data.goalMinutes);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const ratio =
    minutesToday === null || goalMinutes <= 0
      ? 0
      : Math.min(1, minutesToday / goalMinutes);

  return (
    <div className="flex items-center gap-4 text-sm">
      <span className="font-medium text-text" aria-label={`${gam?.xp ?? 0} total XP`}>
        {gam?.xp ?? 0} XP
      </span>
      <span
        className="text-text-muted"
        aria-label={`Current streak ${gam?.streak.currentStreak ?? 0} days`}
      >
        🔥 {gam?.streak.currentStreak ?? 0}
      </span>
      <DailyGoalRing
        ratio={ratio}
        minutesToday={minutesToday ?? 0}
        goalMinutes={goalMinutes}
      />
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
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Daily goal: ${minutesToday} of ${goalMinutes} minutes`}
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
