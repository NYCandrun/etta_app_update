import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export type CardProps = HTMLAttributes<HTMLDivElement>;

// The single shared card surface used app-wide (blocklist #19). Do not invent
// per-screen card styling.
export function Card({ className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-card border border-surface-border bg-surface-raised p-5 shadow-sm",
        className,
      )}
      {...props}
    />
  );
}
