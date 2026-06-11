/** @type {import('tailwindcss').Config} */
// Semantic design tokens only. Components must reference these names
// (primary/accent/success/warning/danger/surface/text), never off-palette
// blue-*/green-* utilities for semantic meaning (blocklist #19, #35).
// Concrete light/dark values live in src/styles/theme.css as CSS variables;
// both themes are tuned for WCAG AA contrast.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "rgb(var(--color-primary) / <alpha-value>)",
          fg: "rgb(var(--color-primary-fg) / <alpha-value>)",
          hover: "rgb(var(--color-primary-hover) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--color-accent) / <alpha-value>)",
          fg: "rgb(var(--color-accent-fg) / <alpha-value>)",
        },
        success: {
          DEFAULT: "rgb(var(--color-success) / <alpha-value>)",
          fg: "rgb(var(--color-success-fg) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "rgb(var(--color-warning) / <alpha-value>)",
          fg: "rgb(var(--color-warning-fg) / <alpha-value>)",
        },
        danger: {
          DEFAULT: "rgb(var(--color-danger) / <alpha-value>)",
          fg: "rgb(var(--color-danger-fg) / <alpha-value>)",
          hover: "rgb(var(--color-danger-hover) / <alpha-value>)",
        },
        surface: {
          DEFAULT: "rgb(var(--color-surface) / <alpha-value>)",
          raised: "rgb(var(--color-surface-raised) / <alpha-value>)",
          muted: "rgb(var(--color-surface-muted) / <alpha-value>)",
          border: "rgb(var(--color-surface-border) / <alpha-value>)",
        },
        text: {
          DEFAULT: "rgb(var(--color-text) / <alpha-value>)",
          muted: "rgb(var(--color-text-muted) / <alpha-value>)",
          inverse: "rgb(var(--color-text-inverse) / <alpha-value>)",
        },
      },
      transitionDuration: {
        // Standardized animation duration tokens (blocklist #50).
        fast: "120ms",
        base: "200ms",
        slow: "320ms",
      },
      borderRadius: {
        card: "0.75rem",
      },
    },
  },
  plugins: [],
};
