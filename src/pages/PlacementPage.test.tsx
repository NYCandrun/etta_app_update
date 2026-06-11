import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ToastProvider } from "../components/ui";
import type { Question } from "../types/contract";

// TESTS REQUIRED (milestone 4): the placement micro-quiz must render a LaTeX
// prompt through the SHARED KaTeX renderer — NOT as the literal string
// "$3x - 7 = 14$" (v1's Diagnostic.tsx showed raw LaTeX; carry-forward #0f).
// We render the page, wait for the first question, and assert KaTeX produced
// real MathML while the raw "$...$" text never appears.

const QUESTIONS: Question[] = [
  {
    id: "q1",
    type: "fill_in_blank",
    prompt: "Solve $3x - 7 = 14$ for $x$.",
    blanks: ["7"],
    explanation: "",
    difficulty: 1,
    isTransfer: false,
  },
];

vi.mock("../lib/ipc", () => ({
  ipc: {
    generatePlacementQuiz: vi.fn(async () => ({ ok: true, data: QUESTIONS })),
    placeLearner: vi.fn(async () => ({ ok: true, data: {} })),
    skipPlacement: vi.fn(async () => ({ ok: true, data: null })),
    getConceptStates: vi.fn(async () => ({ ok: true, data: [] })),
  },
}));

import { PlacementPage } from "./PlacementPage";

function renderPlacement() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/placement"]}>
        <Routes>
          <Route path="/placement" element={<PlacementPage />} />
          <Route path="/dashboard" element={<div>dashboard</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe("PlacementPage math rendering (carry-forward #0f)", () => {
  it("renders a LaTeX prompt via KaTeX, never as literal $...$ text", async () => {
    const { container } = renderPlacement();

    // The prose prompt is rendered; the literal LaTeX delimiters must NOT appear.
    await waitFor(() =>
      expect(screen.getByText(/Solve/)).toBeInTheDocument(),
    );
    expect(container.textContent).not.toContain("$3x - 7 = 14$");
    expect(container.textContent).not.toContain("$x$");

    // KaTeX emits MathML (<math>) and a .katex wrapper — proof it rendered.
    expect(container.querySelector("math")).not.toBeNull();
    expect(container.querySelector(".katex")).not.toBeNull();
  });
});
