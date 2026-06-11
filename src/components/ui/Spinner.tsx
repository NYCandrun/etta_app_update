import { cn } from "../../lib/cn";

export interface SpinnerProps {
  className?: string;
  label?: string;
}

// Inline busy indicator for button/affordance-level loading ONLY. Full-screen
// or content-area loading uses <Skeleton> (one loading pattern app-wide,
// blocklist #18).
export function Spinner({ className, label = "Loading" }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2",
        "border-current border-t-transparent motion-reduce:animate-none",
        className,
      )}
    />
  );
}
