import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";
import { ToastProvider } from "../components/ui";

// WP2 streaming rework (H7 + C3): deltas arrive on a PER-INVOCATION Channel
// (never a global event), every stream carries a frontend-generated requestId,
// and cancel_stream is issued on unmount / concept change / new stream. The
// real src/lib/ipc.ts runs here — only the Tauri boundary is mocked — so the
// Channel wiring in streamGenerate is exercised, not stubbed away.

// A generate_streamed invocation captured at the Tauri boundary: its args, the
// Channel it was handed (drive deltas via channel.onmessage), and the deferred
// settle controls for the command's returned promise.
type StreamCall = {
  args: Record<string, unknown>;
  channel: { onmessage: (chunk: string) => void };
  resolve: (fullText: string) => void;
  reject: (error: unknown) => void;
};

const boundary = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: boundary.invoke,
  // Minimal Channel mock matching what ipc.ts uses: construct + set onmessage.
  Channel: class {
    onmessage: (msg: unknown) => void = () => {};
  },
}));

vi.mock("../stores/useGamificationStore", () => ({
  useGamificationStore: (sel: (s: unknown) => unknown) => sel({ setState: vi.fn() }),
}));

import { LessonPage } from "./LessonPage";

let streamCalls: StreamCall[] = [];
let cancelCalls: Array<Record<string, unknown> | undefined> = [];
let uuidCounter = 0;

beforeEach(() => {
  streamCalls = [];
  cancelCalls = [];
  uuidCounter = 0;
  // Deterministic requestIds so cancellation targets are assertable.
  vi.stubGlobal("crypto", { randomUUID: () => `req-${++uuidCounter}` });

  boundary.invoke.mockReset();
  boundary.invoke.mockImplementation((cmd, args) => {
    if (cmd === "generate_streamed") {
      return new Promise<string>((resolve, reject) => {
        streamCalls.push({
          args: args ?? {},
          channel: (args?.onDelta ?? {}) as StreamCall["channel"],
          resolve,
          reject,
        });
      });
    }
    if (cmd === "cancel_stream") {
      cancelCalls.push(args);
      return Promise.resolve(null);
    }
    // award_lesson_xp, add_study_minutes, … — succeed quietly.
    return Promise.resolve(null);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderLesson(initialConcept = "alg_001") {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/lesson/${initialConcept}`]}>
        <Harness />
      </MemoryRouter>
    </ToastProvider>,
  );
}

// Routes plus a navigation trigger so tests can change :conceptId in place
// (the page stays mounted — the route param changes, as in the real app).
function Harness() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/lesson/alg_002")}>go-to-alg-002</button>
      <Routes>
        <Route path="/lesson/:conceptId" element={<LessonPage />} />
        <Route path="/quiz/:conceptId" element={<div>quiz-page</div>} />
      </Routes>
    </>
  );
}

describe("LessonPage Channel streaming (H7 + C3)", () => {
  it("streams lesson deltas through the per-invocation channel and treats the returned full text as authoritative", async () => {
    renderLesson();
    await waitFor(() => expect(streamCalls.length).toBe(1));

    const call = streamCalls[0]!;
    expect(call.args.conceptId).toBe("alg_001");
    expect(call.args.mode).toBe("lesson");
    expect(call.args.requestId).toBe("req-1");
    // C3: reinforcement is decided SERVER-side from real recent mistakes —
    // the lesson request must carry NO frontend-supplied user input.
    expect(call.args.userInput).toBeNull();
    // The delta channel travels as a command argument (per-invocation).
    expect(call.args.onDelta).toBe(call.channel);

    // Deltas render incrementally…
    act(() => call.channel.onmessage("partial chunk"));
    expect(await screen.findByText(/partial chunk/)).toBeInTheDocument();

    // …but the command's returned FULL text wins over accumulated deltas
    // (guards any dropped chunk).
    await act(async () => call.resolve("the complete authoritative lesson"));
    expect(
      await screen.findByText(/the complete authoritative lesson/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/partial chunk/)).not.toBeInTheDocument();
  });

  it("cancels the active stream on unmount", async () => {
    const { unmount } = renderLesson();
    await waitFor(() => expect(streamCalls.length).toBe(1));
    expect(streamCalls[0]!.args.requestId).toBe("req-1");

    unmount(); // the stream is still in flight

    await waitFor(() =>
      expect(cancelCalls).toContainEqual({ requestId: "req-1" }),
    );
  });

  it("starting a stream for a different concept cancels the previous requestId", async () => {
    renderLesson();
    await waitFor(() => expect(streamCalls.length).toBe(1));

    // Navigate while the first stream is still in flight.
    fireEvent.click(screen.getByText("go-to-alg-002"));

    await waitFor(() => expect(streamCalls.length).toBe(2));
    // The superseded stream was cancelled by its exact id…
    expect(cancelCalls).toContainEqual({ requestId: "req-1" });
    // …and the new stream is a fresh id for the new concept.
    expect(streamCalls[1]!.args.conceptId).toBe("alg_002");
    expect(streamCalls[1]!.args.requestId).toBe("req-2");
  });

  it("explain keeps its strategy + question and gets its own cancellable requestId", async () => {
    renderLesson();
    await waitFor(() => expect(streamCalls.length).toBe(1));
    await act(async () => streamCalls[0]!.resolve("lesson text"));

    fireEvent.click(screen.getByRole("button", { name: /I don't get it/ }));

    await waitFor(() => expect(streamCalls.length).toBe(2));
    const explain = streamCalls[1]!;
    expect(explain.args.mode).toBe("explain");
    expect(explain.args.strategy).toBe("textbook");
    // Explain stays conversational: it DOES carry the learner's question.
    expect(explain.args.userInput).toBeTruthy();
    expect(explain.args.requestId).toBe("req-2");
  });
});

describe("LessonPage flow hardening (WP3)", () => {
  it("clears residual explanation + strategy rung when the concept changes", async () => {
    renderLesson();
    await waitFor(() => expect(streamCalls.length).toBe(1));
    await act(async () => streamCalls[0]!.resolve("lesson one"));

    // Rung 1 explanation for alg_001 arrives and advances the ladder.
    fireEvent.click(screen.getByRole("button", { name: /I don't get it/ }));
    await waitFor(() => expect(streamCalls.length).toBe(2));
    await act(async () => streamCalls[1]!.resolve("explanation for alg_001"));
    expect(screen.getByText(/explanation for alg_001/)).toBeInTheDocument();

    // Switching concepts must not leak the old explanation under the new
    // lesson, and the ladder restarts at "textbook".
    fireEvent.click(screen.getByText("go-to-alg-002"));
    await waitFor(() => expect(streamCalls.length).toBe(3));
    expect(screen.queryByText(/explanation for alg_001/)).not.toBeInTheDocument();

    await act(async () => streamCalls[2]!.resolve("lesson two"));
    fireEvent.click(screen.getByRole("button", { name: /I don't get it/ }));
    await waitFor(() => expect(streamCalls.length).toBe(4));
    expect(streamCalls[3]!.args.strategy).toBe("textbook"); // rung reset
  });

  it("disables 'Ready for quiz' while an explanation is streaming and while the lesson failed", async () => {
    renderLesson();
    await waitFor(() => expect(streamCalls.length).toBe(1));

    // FAILED lesson: Retry is the only forward path. (Both the inline error
    // card and the toast offer Retry; the INLINE one is first in DOM order.)
    await act(async () => streamCalls[0]!.reject("model exploded"));
    expect(screen.getByRole("button", { name: /ready for quiz/i })).toBeDisabled();
    const retries = screen.getAllByRole("button", { name: /retry/i });
    expect(retries.length).toBeGreaterThan(0);

    // Retry succeeds → button re-enables.
    fireEvent.click(retries[0]!);
    await waitFor(() => expect(streamCalls.length).toBe(2));
    await act(async () => streamCalls[1]!.resolve("lesson text"));
    expect(screen.getByRole("button", { name: /ready for quiz/i })).toBeEnabled();

    // While an explain stream is IN FLIGHT, a deliberate tap must not race it.
    fireEvent.click(screen.getByRole("button", { name: /I don't get it/ }));
    await waitFor(() => expect(streamCalls.length).toBe(3));
    expect(screen.getByRole("button", { name: /ready for quiz/i })).toBeDisabled();
    await act(async () => streamCalls[2]!.resolve("explained"));
    expect(screen.getByRole("button", { name: /ready for quiz/i })).toBeEnabled();
  });

  // T4b: a stream that dies AFTER partial deltas must not masquerade as a
  // complete lesson — persistent inline error above the partial text and
  // 'Ready for quiz' disabled until a successful full load.
  it("mid-stream failure keeps a persistent inline error, keeps the partial text, and disables 'Ready for quiz'", async () => {
    renderLesson();
    await waitFor(() => expect(streamCalls.length).toBe(1));

    act(() => streamCalls[0]!.channel.onmessage("partial lesson text"));
    await act(async () => streamCalls[0]!.reject("stream died mid-flight"));

    // Partial text stays readable…
    expect(screen.getByText(/partial lesson text/)).toBeInTheDocument();
    // …under a PERSISTENT inline error card (not just the 6s toast).
    expect(
      screen.getByText(/The lesson stopped before finishing/),
    ).toBeInTheDocument();
    // A truncated lesson is not a gateway to the quiz.
    expect(screen.getByRole("button", { name: /ready for quiz/i })).toBeDisabled();

    // Retry from the inline card (first in DOM order) reloads and re-enables.
    fireEvent.click(screen.getAllByRole("button", { name: /retry/i })[0]!);
    await waitFor(() => expect(streamCalls.length).toBe(2));
    await act(async () => streamCalls[1]!.resolve("the full recovered lesson"));
    expect(
      screen.queryByText(/The lesson stopped before finishing/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ready for quiz/i })).toBeEnabled();
  });

  // T4a: a loadLesson that supersedes an in-flight explain stream must reset
  // `explaining` — the superseded stream's own .then returns early on the gen
  // mismatch, and without the reset both action buttons stay disabled forever.
  it("superseding an in-flight explain stream via lesson Retry resets `explaining`", async () => {
    renderLesson();
    await waitFor(() => expect(streamCalls.length).toBe(1));

    // Lesson fails MID-stream: partial text + persistent inline Retry.
    act(() => streamCalls[0]!.channel.onmessage("partial lesson"));
    await act(async () => streamCalls[0]!.reject("stream died"));

    // 'I don't get it' is still available (there is content to ask about).
    fireEvent.click(screen.getByRole("button", { name: /I don't get it/ }));
    await waitFor(() => expect(streamCalls.length).toBe(2));
    expect(screen.getByRole("button", { name: /thinking/i })).toBeInTheDocument();

    // Retry the LESSON while the explain stream is in flight: loadLesson
    // cancels the explain stream and bumps the stream generation.
    fireEvent.click(screen.getAllByRole("button", { name: /retry/i })[0]!);
    await waitFor(() => expect(streamCalls.length).toBe(3));
    expect(cancelCalls).toContainEqual({ requestId: "req-2" });

    // The cancelled explain stream settles as a backend-marked cancellation.
    await act(async () =>
      streamCalls[1]!.reject("EttaError:cancelled: stream cancelled"),
    );
    await act(async () => streamCalls[2]!.resolve("recovered lesson"));

    // Neither button is stuck: 'Thinking…' cleared, both re-enabled.
    expect(screen.queryByRole("button", { name: /thinking/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /I don't get it/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /ready for quiz/i })).toBeEnabled();
  });

  // T11: the explain card is captioned with the strategy that PRODUCED the
  // content — the rung index advances on success and must not mislabel it.
  it("labels the explain card with the strategy that produced the displayed content", async () => {
    renderLesson();
    await waitFor(() => expect(streamCalls.length).toBe(1));
    await act(async () => streamCalls[0]!.resolve("lesson text"));

    // Rung 1: textbook produces the content → card says Textbook, not the
    // next rung (Analogy / visual).
    fireEvent.click(screen.getByRole("button", { name: /I don't get it/ }));
    await waitFor(() => expect(streamCalls.length).toBe(2));
    expect(streamCalls[1]!.args.strategy).toBe("textbook");
    await act(async () => streamCalls[1]!.resolve("first explanation"));
    expect(screen.getByText("Textbook explanation")).toBeInTheDocument();
    expect(screen.queryByText("Analogy / visual")).not.toBeInTheDocument();

    // Rung 2: analogy produces the next content → card advances with it.
    fireEvent.click(screen.getByRole("button", { name: /I don't get it/ }));
    await waitFor(() => expect(streamCalls.length).toBe(3));
    expect(streamCalls[2]!.args.strategy).toBe("analogy");
    await act(async () => streamCalls[2]!.resolve("second explanation"));
    expect(screen.getByText("Analogy / visual")).toBeInTheDocument();
    expect(screen.queryByText("Textbook explanation")).not.toBeInTheDocument();
  });

  it("navigates to the quiz even when awardLessonXp fails (non-blocking toast)", async () => {
    boundary.invoke.mockImplementation((cmd, args) => {
      if (cmd === "generate_streamed") {
        return new Promise<string>((resolve, reject) => {
          streamCalls.push({
            args: args ?? {},
            channel: (args?.onDelta ?? {}) as StreamCall["channel"],
            resolve,
            reject,
          });
        });
      }
      if (cmd === "cancel_stream") {
        cancelCalls.push(args);
        return Promise.resolve(null);
      }
      if (cmd === "award_lesson_xp") {
        return Promise.reject("xp ledger locked");
      }
      return Promise.resolve(null);
    });

    renderLesson();
    await waitFor(() => expect(streamCalls.length).toBe(1));
    await act(async () => streamCalls[0]!.resolve("lesson text"));

    fireEvent.click(screen.getByRole("button", { name: /ready for quiz/i }));

    // The learner is on the quiz — the failed award only toasts.
    expect(await screen.findByText("quiz-page")).toBeInTheDocument();
    expect(
      await screen.findByText(/Could not record lesson completion/),
    ).toBeInTheDocument();
  });
});
