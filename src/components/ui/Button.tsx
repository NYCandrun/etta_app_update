import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  // Sizing lives HERE, not in caller className overrides: cn() does no
  // Tailwind conflict resolution, so utilities like px-3/text-xs appended by a
  // caller silently lose to the base px-4/text-sm (stylesheet order wins, not
  // class order). Compact buttons must pass size="sm" instead.
  size?: ButtonSize;
}

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg " +
  "font-medium transition-colors duration-base " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-surface " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const sizes: Record<ButtonSize, string> = {
  md: "px-4 py-2 text-sm",
  sm: "px-3 py-1 text-xs",
};

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary-hover",
  secondary:
    "bg-surface-muted text-text border border-surface-border hover:bg-surface-raised",
  ghost: "bg-transparent text-text hover:bg-surface-muted",
  danger: "bg-danger text-danger-fg hover:bg-danger-hover",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "primary", size = "md", className, type, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(base, variants[variant], sizes[size], className)}
        {...props}
      />
    );
  },
);
