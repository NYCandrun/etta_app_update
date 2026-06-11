import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Card, InlineError, Skeleton, useToast } from "./ui";
import { ipc } from "../lib/ipc";

// First-run routing gate. On launch we ask the backend whether onboarding +
// placement has completed (the reserved `__onboarding_complete` flag). Until we
// know, we show the shared skeleton (no layout shift, #18); if the learner
// hasn't onboarded we redirect to /onboarding. The onboarding + placement routes
// themselves are NOT gated (otherwise we'd redirect away from them).
type GateState =
  | { status: "checking" }
  | { status: "error"; message: string }
  | { status: "complete"; done: boolean };

const ONBOARDING_PATHS = ["/onboarding", "/placement"];

export function OnboardingGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { showError } = useToast();
  const [state, setState] = useState<GateState>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      setState({ status: "checking" });
      void ipc.getOnboardingComplete().then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setState({ status: "error", message: res.error });
          showError(`Could not check your setup: ${res.error}`, check);
          return;
        }
        setState({ status: "complete", done: res.data });
      });
    };
    check();
    return () => {
      cancelled = true;
    };
  }, [showError]);

  // Don't gate the onboarding/placement flow itself.
  const onOnboardingFlow = ONBOARDING_PATHS.some((p) =>
    location.pathname.startsWith(p),
  );
  if (onOnboardingFlow) return <>{children}</>;

  if (state.status === "checking") {
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

  if (state.status === "error") {
    return (
      <div className="mx-auto flex min-h-full max-w-xl items-center px-4">
        <Card className="w-full">
          <InlineError message={state.message} />
        </Card>
      </div>
    );
  }

  if (!state.done) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}
