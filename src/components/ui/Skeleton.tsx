import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export type SkeletonProps = HTMLAttributes<HTMLDivElement>;

// The ONE app-wide loading primitive (blocklist #18). Callers MUST size the
// skeleton to match the final content (explicit width/height via className) so
// there is no layout shift when real content arrives. Do not mix spinners and
// skeletons across screens; use <Spinner> only for inline button-busy states.
export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-md bg-surface-muted motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}
