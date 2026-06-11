import { NavLink, Outlet } from "react-router-dom";
import { cn } from "../lib/cn";

const NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/progress", label: "Progress" },
  { to: "/settings", label: "Settings" },
] as const;

// Minimal shared chrome. A real responsive sidebar arrives in a later
// milestone; this exists so routes render inside consistent layout.
export function AppLayout() {
  return (
    <div className="flex min-h-full flex-col bg-surface text-text">
      <header className="border-b border-surface-border bg-surface-raised">
        <nav
          aria-label="Primary"
          className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3"
        >
          <span className="font-semibold">Etta</span>
          <ul className="flex gap-2">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      "rounded-md px-3 py-1.5 text-sm transition-colors duration-base",
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
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
