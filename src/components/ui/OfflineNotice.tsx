import { cn } from "../../lib/cn";

export interface OfflineNoticeProps {
  // Optional extra context (e.g. "AI lessons and quizzes are paused").
  detail?: string;
  className?: string;
}

// Accessible offline banner (milestone 5, item #11). It explains WHY AI actions
// are disabled and pairs an icon glyph with text so color is not the only signal
// (blocklist #33). It is announced politely (aria-live) when it appears. The
// actual DISABLING of AI controls happens at each call site via `useOnline()` —
// this notice is the messaging half of "disabled with clear messaging".
export function OfflineNotice({ detail, className }: OfflineNoticeProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-text",
        className,
      )}
    >
      <span aria-hidden="true" className="font-semibold text-warning">
        ⚠
      </span>
      <div className="flex-1">
        <p className="font-medium">You're offline</p>
        <p className="text-text-muted">
          {detail ??
            "AI lessons and quizzes need a connection and are paused. You can still review cached content. Actions will re-enable automatically when you're back online."}
        </p>
      </div>
    </div>
  );
}
