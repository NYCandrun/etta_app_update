import { useEffect, useState, useSyncExternalStore } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { cn } from "../lib/cn";
import { useLeaveGuardStore } from "../stores/useLeaveGuardStore";
import { ProgressIndicators } from "./ProgressIndicators";

const NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/progress", label: "Progress" },
  { to: "/settings", label: "Settings" },
] as const;

// Tracks the md breakpoint (Tailwind's 768px) so the drawer can be made inert
// only when it is actually off-canvas: on md+ the sidebar is a static column
// and must stay tabbable regardless of navOpen.
const MD_QUERY = "(min-width: 768px)";

function subscribeMd(onChange: () => void): () => void {
  const mq = window.matchMedia(MD_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getMdSnapshot(): boolean {
  return window.matchMedia(MD_QUERY).matches;
}

function useIsMdUp(): boolean {
  return useSyncExternalStore(subscribeMd, getMdSnapshot, () => true);
}

// Shared app chrome (milestone 5, #37/#38). A fixed sidebar on md+ screens; on
// small (phone-width) screens the sidebar collapses behind a hamburger and
// slides in as an overlay so it never steals horizontal space (v1's fixed 240px
// sidebar left ~80px on a phone). A skip link jumps keyboard users straight to
// the main content (#31); focus order is hamburger → nav → main.
export function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  const isMdUp = useIsMdUp();
  const location = useLocation();

  // Close the mobile drawer whenever the route changes (so navigating doesn't
  // leave the overlay covering the new page).
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Close on Escape for keyboard users while the drawer is open.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  return (
    <div className="flex min-h-full bg-surface text-text">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-fg"
      >
        Skip to main content
      </a>

      {/* Backdrop behind the mobile drawer; click to dismiss. md+ never shows it. */}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
        />
      )}

      {/* Sidebar: static column on md+, off-canvas drawer on small screens.
          While closed off-canvas it is `inert` so Tab can never land on the
          invisible nav links (and screen readers skip it); md+ never inerts. */}
      <aside
        id="primary-navigation"
        inert={!navOpen && !isMdUp}
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-60 shrink-0 border-r border-surface-border bg-surface-raised",
          "transition-transform duration-base md:static md:translate-x-0 motion-reduce:transition-none",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-4 py-4">
          <span className="text-lg font-semibold">Etta</span>
          {/* Close button is only meaningful inside the mobile drawer. */}
          <button
            type="button"
            className="rounded-md p-1 text-text-muted hover:bg-surface-muted md:hidden"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <nav aria-label="Primary" className="px-2">
          <ul className="flex flex-col gap-1">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  onClick={(e) => {
                    // Leave guard (declarative HashRouter has no useBlocker):
                    // an in-progress page (e.g. a mid-quiz QuizPage) registers
                    // a guard; when it blocks, the page shows its own inline
                    // confirm and navigates itself on "Leave".
                    const guard = useLeaveGuardStore.getState().guard;
                    if (guard && guard(item.to)) {
                      e.preventDefault();
                      setNavOpen(false); // reveal the page's confirm UI
                    }
                  }}
                  className={({ isActive }) =>
                    cn(
                      "block rounded-md px-3 py-2 text-sm transition-colors duration-base motion-reduce:transition-none",
                      isActive
                        ? "bg-primary text-primary-fg"
                        : "text-text-muted hover:bg-surface-muted",
                    )
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      {/* Content column: top bar (hamburger + progress) then the routed page. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-surface-border bg-surface-raised px-4 py-3 md:px-8">
          <button
            type="button"
            className="rounded-md p-1 text-text hover:bg-surface-muted md:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={navOpen}
            aria-controls="primary-navigation"
          >
            <span aria-hidden="true" className="text-xl leading-none">
              ☰
            </span>
          </button>
          {/* App name in the bar on small screens (the sidebar title is hidden). */}
          <span className="font-semibold md:hidden">Etta</span>
          <div className="ml-auto">
            <ProgressIndicators />
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 md:px-8"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
