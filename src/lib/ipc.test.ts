import { describe, it, expect, vi } from "vitest";

// T9: machine markers ("EttaError:<kind>:") exist for DETECTION only — they
// must never reach learner-visible copy. formatIpcError strips them (wherever
// they sit in a composed message) while the detection helpers keep working on
// the RAW string.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (msg: unknown) => void = () => {};
  },
}));

import { formatIpcError, isApiKeyError, isCancelledError } from "./ipc";

describe("formatIpcError", () => {
  it("strips the api_key marker prefix from a backend error", () => {
    expect(
      formatIpcError("EttaError:api_key: the API key was rejected — update it in Settings"),
    ).toBe("the API key was rejected — update it in Settings");
  });

  it("strips the marker even when call sites prefixed their own context", () => {
    expect(
      formatIpcError("Could not load the quiz: EttaError:api_key: the API key was rejected"),
    ).toBe("Could not load the quiz: the API key was rejected");
  });

  it("strips the cancelled marker", () => {
    expect(formatIpcError("EttaError:cancelled: stream cancelled by user")).toBe(
      "stream cancelled by user",
    );
  });

  it("falls back to a readable message when the marker is the whole string", () => {
    expect(formatIpcError("EttaError:cancelled")).toBe(
      "The request was interrupted.",
    );
  });

  it("leaves marker-free messages untouched", () => {
    expect(formatIpcError("the model returned malformed JSON")).toBe(
      "the model returned malformed JSON",
    );
  });
});

describe("marker detection stays on the RAW string", () => {
  it("isApiKeyError detects the marker anywhere in the message", () => {
    expect(isApiKeyError("Could not start: EttaError:api_key: rejected")).toBe(true);
    expect(isApiKeyError("plain failure")).toBe(false);
  });

  it("isCancelledError detects the marker prefix", () => {
    expect(isCancelledError("EttaError:cancelled: stream cancelled")).toBe(true);
    expect(isCancelledError("EttaError:api_key: rejected")).toBe(false);
  });
});
