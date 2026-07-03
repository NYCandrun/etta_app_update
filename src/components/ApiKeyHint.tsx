import { Link } from "react-router-dom";
import { isApiKeyError } from "../lib/ipc";
import { useOnboardingStore } from "../stores/useOnboardingStore";

// When a command failed because the API key was rejected (the backend marks
// those errors with EttaError:api_key — WP1a), retrying is pointless until the
// key is fixed. Render a direct path to the screen that can actually fix it:
// - after onboarding: /settings (the normal key management surface);
// - BEFORE onboarding is complete (placement / first-run): /settings is gated
//   away by OnboardingGate, so the only reachable fix-it surface is the
//   onboarding key step — deep-linked via ?step=key.
export function ApiKeyHint({ error }: { error: string }) {
  const onboardingDone = useOnboardingStore((s) => s.status === "done");
  if (!isApiKeyError(error)) return null;
  const to = onboardingDone ? "/settings" : "/onboarding?step=key";
  return (
    <p className="mt-2 text-sm text-text">
      Your API key was rejected.{" "}
      <Link to={to} className="text-primary underline hover:no-underline">
        {onboardingDone
          ? "Fix your API key in Settings"
          : "Fix your API key to continue"}
      </Link>
    </p>
  );
}
