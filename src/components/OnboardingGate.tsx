import { useEffect } from "react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Card, InlineError, Skeleton } from "./ui";
import { useOnboardingStore } from "../stores/useOnboardingStore";

// First-run routing gate (C1). The onboarding-complete flag lives in
// useOnboardingStore and is hydrated exactly ONCE at boot; `done` is TERMINAL,
// so navigating around the app never re-checks the backend and never flashes
// the skeleton again. PlacementPage calls markComplete() on BOTH success paths
// (place_learner and skip), which unblocks the gate immediately — no relaunch.
// The onboarding + placement routes themselves are NOT gated (otherwise we'd
// redirect away from them).

const ONBOARDING_PATHS = ["/onboarding", "/placement"];

export function OnboardingGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const status = useOnboardingStore((s) => s.status);
  const error = useOnboardingStore((s) => s.error);
  const hydrate = useOnboardingStore((s) => s.hydrate);

  // Hydrate once at boot. hydrate() is idempotent (no-op unless the store is
  // in `unknown` or `error`), so re-renders and re-mounts never re-fetch.
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Don't gate the onboarding/placement flow itself.
  const onOnboardingFlow = ONBOARDING_PATHS.some((p) =>
    location.pathname.startsWith(p),
  );
  if (onOnboardingFlow) return <>{children}</>;

  if (status === "unknown" || status === "checking") {
    return (
      <div className="mx-auto flex min-h-full max-w-xl items-center px-4">
        <Card className="w-full">
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-10 w-full" />
          </div>
        </Card>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="mx-auto flex min-h-full max-w-xl items-center px-4">
        <Card className="w-full">
          <InlineError
            message={`Could not check your setup: ${error ?? "unknown error"}`}
            onRetry={hydrate}
          />
        </Card>
      </div>
    );
  }

  if (status === "pending") {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}
