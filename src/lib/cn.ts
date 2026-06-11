// Minimal class-name joiner. Falsy values are dropped; later values win only
// at the string level (no Tailwind conflict resolution needed for our scoped
// token-based classes).
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
