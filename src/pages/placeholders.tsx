import { Card } from "../components/ui";

// Empty placeholder page. Onboarding, Placement, and Dashboard are real screens
// (M4); Progress is built in a later milestone. It renders a titled Card so the
// route is visibly reachable.
export function ProgressPage() {
  return (
    <Card>
      <h1 className="text-xl font-semibold text-text">Progress</h1>
      <p className="mt-1 text-sm text-text-muted">
        This screen is built in a later milestone.
      </p>
    </Card>
  );
}
