import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "./ErrorToast";

// Test harness: a button that raises an identical toast per click (the
// worst case for id collisions — same message, same millisecond).
function Raiser() {
  const { showError } = useToast();
  return (
    <button type="button" onClick={() => showError("same error")}>
      raise
    </button>
  );
}

function RaiseMany({ messages }: { messages: string[] }) {
  const { showError } = useToast();
  return (
    <button type="button" onClick={() => messages.forEach((m) => showError(m))}>
      raise-many
    </button>
  );
}

describe("ErrorToast behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-dismisses after 6 seconds", () => {
    render(
      <ToastProvider>
        <RaiseMany messages={["boom"]} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("raise-many"));
    expect(screen.getByRole("alert")).toHaveTextContent("boom");

    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(screen.queryByRole("alert")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("pauses the timer on hover and restarts it on leave", () => {
    render(
      <ToastProvider>
        <RaiseMany messages={["hover me"]} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("raise-many"));
    const toast = screen.getByRole("alert");

    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // Still visible while hovered, long past the 6s window.
    expect(screen.queryByRole("alert")).not.toBeNull();

    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("caps concurrent toasts at 3, dropping the oldest", () => {
    render(
      <ToastProvider>
        <RaiseMany messages={["one", "two", "three", "four"]} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("raise-many"));
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(3);
    expect(screen.queryByText("one")).toBeNull();
    expect(screen.getByText("two")).toBeInTheDocument();
    expect(screen.getByText("four")).toBeInTheDocument();
  });

  it("dismissing one toast removes exactly that toast (ids never collide)", () => {
    render(
      <ToastProvider>
        <Raiser />
      </ToastProvider>,
    );
    // Two separate clicks — under the old Date.now()+length scheme these could
    // collide when produced within the same millisecond.
    fireEvent.click(screen.getByText("raise"));
    fireEvent.click(screen.getByText("raise"));
    expect(screen.getAllByRole("alert")).toHaveLength(2);

    const dismissButtons = screen.getAllByRole("button", { name: "Dismiss" });
    fireEvent.click(dismissButtons[0] as HTMLElement);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("Retry runs the callback and closes the toast", () => {
    const retry = vi.fn();
    function RaiseWithRetry() {
      const { showError } = useToast();
      return (
        <button type="button" onClick={() => showError("failed", retry)}>
          raise
        </button>
      );
    }
    render(
      <ToastProvider>
        <RaiseWithRetry />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("raise"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
