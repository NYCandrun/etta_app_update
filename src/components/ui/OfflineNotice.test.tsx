import { describe, it, expect, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { OfflineNotice } from "./OfflineNotice";

// Force navigator.onLine and notify useOnline subscribers.
function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => value,
  });
  act(() => {
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
}

afterEach(() => {
  setOnline(true);
});

describe("OfflineNotice live region", () => {
  it("keeps the aria-live region mounted while online, with no banner content", () => {
    setOnline(true);
    render(<OfflineNotice />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
  });

  it("announces by toggling content INSIDE the already-mounted region", () => {
    render(<OfflineNotice detail="AI actions are paused." />);
    const region = screen.getByRole("status");
    expect(region).toBeEmptyDOMElement();

    setOnline(false);
    // Same region node, now with content — the reliable live-region pattern.
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("You're offline");
    expect(region).toHaveTextContent("AI actions are paused.");

    setOnline(true);
    expect(region).toBeEmptyDOMElement();
  });
});
