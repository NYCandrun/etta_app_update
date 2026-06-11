import { useParams } from "react-router-dom";
import { Card } from "../components/ui";

// Empty placeholder pages for Milestone 0. Real screens land in later
// milestones. Each renders a titled Card so the route is visibly reachable.

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

export function LessonPage() {
  const { conceptId } = useParams();
  return <Placeholder title={`Lesson — ${conceptId ?? ""}`} />;
}

export function QuizPage() {
  const { conceptId } = useParams();
  return <Placeholder title={`Quiz — ${conceptId ?? ""}`} />;
}

export function ProjectPage() {
  const { conceptId } = useParams();
  return <Placeholder title={`Project — ${conceptId ?? ""}`} />;
}

export function ProgressPage() {
  return <Placeholder title="Progress" />;
}

export function SettingsPage() {
  return <Placeholder title="Settings" />;
}
