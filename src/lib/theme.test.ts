import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolveTheme,
  applyTheme,
  watchSystemTheme,
  THEME_STORAGE_KEY,
} from "./theme";

// The jsdom test environment ships no window.localStorage; install a minimal
// in-memory stub (the theme boot cache only needs get/set/clear). applyTheme
// itself must ALSO work when storage is missing entirely — covered below.
function installLocalStorage(): { setItem: ReturnType<typeof vi.fn> } {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => {
      store.set(k, String(v));
    }),
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: stub,
  });
  return stub;
}

describe("theme system", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("dark");
    installLocalStorage();
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

  it("applyTheme mirrors the PREFERENCE to the boot cache key", () => {
    applyTheme("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    // "system" is stored as-is so the boot snippet keeps tracking the OS,
    // never a frozen resolved value.
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList);
    applyTheme("system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("applyTheme is idempotent", () => {
    applyTheme("dark");
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("applyTheme survives an unavailable localStorage (boot cache only)", () => {
    const stub = installLocalStorage();
    stub.setItem.mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(() => applyTheme("dark")).not.toThrow();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
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
