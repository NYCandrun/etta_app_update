import { cn } from "../../lib/cn";
import { useOnline } from "../../lib/useOnline";

export interface OfflineNoticeProps {
  // Optional extra context (e.g. "AI lessons and quizzes are paused").
  detail?: string;
  className?: string;
}

// Accessible offline banner (milestone 5, item #11). It explains WHY AI actions
// are disabled and pairs an icon glyph with text so color is not the only signal
// (blocklist #33). The actual DISABLING of AI controls happens at each call site
// via `useOnline()` — this notice is the messaging half of "disabled with clear
// messaging".
//
// Live-region contract: the aria-live region is ALWAYS mounted and only its
// CONTENT toggles with connectivity — screen readers frequently skip a live
// region that enters the DOM already containing text. The component gates
// itself on `useOnline()`, so call sites should render it UNconditionally
// (legacy `{!online && <OfflineNotice/>}` wrappers still work, they just
// forfeit the always-mounted announcement benefit until removed).
export function OfflineNotice({ detail, className }: OfflineNoticeProps) {
  const online = useOnline();
  return (
    <div role="status" aria-live="polite">
      {!online && (
        <div
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
      )}
    </div>
  );
}
