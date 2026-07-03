import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ToastProvider } from "./ui";
import { useOnboardingStore } from "../stores/useOnboardingStore";

// C1: the gate hydrates the onboarding flag ONCE at boot; a failed check
// renders an error card with a working Retry (never a dead skeleton), and a
// successful re-check routes normally. Terminality (done never re-fetched) is
// covered end-to-end in PlacementPage.test.tsx.

const getOnboardingComplete = vi.hoisted(() => vi.fn());

vi.mock("../lib/ipc", () => ({
  ipc: { getOnboardingComplete },
}));

import { OnboardingGate } from "./OnboardingGate";

beforeEach(() => {
  getOnboardingComplete.mockReset();
  useOnboardingStore.setState({ status: "unknown", error: null });
});

function renderGated() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <OnboardingGate>
          <Routes>
            <Route path="/dashboard" element={<div>dashboard-page</div>} />
            <Route path="/onboarding" element={<div>onboarding-page</div>} />
          </Routes>
        </OnboardingGate>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe("OnboardingGate error card (C1)", () => {
  it("renders Retry on a failed check; retrying re-runs the check and routes", async () => {
    getOnboardingComplete
      .mockImplementationOnce(async () => ({ ok: false, error: "ipc down" }))
      .mockImplementationOnce(async () => ({ ok: true, data: false }));

    renderGated();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("ipc down");

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    // Second check succeeds with done:false → redirect to onboarding.
    expect(await screen.findByText("onboarding-page")).toBeInTheDocument();
    expect(getOnboardingComplete).toHaveBeenCalledTimes(2);
  });

  it("lets a returning (done) user straight through", async () => {
    getOnboardingComplete.mockImplementation(async () => ({ ok: true, data: true }));
    renderGated();
    expect(await screen.findByText("dashboard-page")).toBeInTheDocument();
  });
});
