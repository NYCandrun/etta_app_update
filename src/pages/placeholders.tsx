import { Card } from "../components/ui";

// Empty placeholder pages. Lesson and Quiz are real screens (M3); Dashboard,
// Progress, and Onboarding are wired in M4. Each renders a titled Card so the
// route is visibly reachable.

function Placeholder({ title }: { title: string }) {
  return (
    <Card>
      <h1 className="text-xl font-semibold text-text">{title}</h1>
      <p className="mt-1 text-sm text-text-muted">
        This screen is built in a later milestone.
      </p>
    </Card>
  );
}

export function OnboardingPage() {
  return <Placeholder title="Onboarding" />;
}

export function DashboardPage() {
  return <Placeholder title="Dashboard" />;
}

export function ProgressPage() {
  return <Placeholder title="Progress" />;
}
