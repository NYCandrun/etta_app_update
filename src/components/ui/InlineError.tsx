import { Button } from "./Button";
import { cn } from "../../lib/cn";
import { LABELS } from "../../lib/labels";

export interface InlineErrorProps {
  message: string;
  onRetry?: () => void;
  className?: string;
}

// Accessible inline error for failed async ops (blocklist #16, #23: never a
// native alert(), never a silent blank screen). Pairs an icon glyph with text
// so color is not the only signal (blocklist #33).
export function InlineError({ message, onRetry, className }: InlineErrorProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-text",
        className,
      )}
    >
      <span aria-hidden="true" className="font-semibold text-danger">
        !
      </span>
      <div className="flex-1">
        <p>{message}</p>
        {onRetry && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={onRetry}
          >
            {LABELS.retry}
          </Button>
        )}
      </div>
    </div>
  );
}
