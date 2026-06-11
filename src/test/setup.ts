import "@testing-library/jest-dom/vitest";
import "@testing-library/react";

// jsdom does not implement matchMedia; provide a minimal stub so theme code
// that calls window.matchMedia('(prefers-color-scheme: dark)') works in tests.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
