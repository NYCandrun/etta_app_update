import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveTheme, applyTheme, watchSystemTheme } from "./theme";

describe("theme system", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("resolves explicit preferences directly", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("resolves system via matchMedia", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList);
    expect(resolveTheme("system")).toBe("dark");
  });

  it("applyTheme toggles the dark class", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("watchSystemTheme registers a change listener only for system", () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
      addEventListener: add,
      removeEventListener: remove,
    } as unknown as MediaQueryList);

    const onChange = vi.fn();
    const unsub = watchSystemTheme("system", onChange);
    expect(add).toHaveBeenCalledWith("change", onChange);
    unsub();
    expect(remove).toHaveBeenCalledWith("change", onChange);

    // Non-system preference does not subscribe.
    add.mockClear();
    watchSystemTheme("light", onChange);
    expect(add).not.toHaveBeenCalled();
  });
});
