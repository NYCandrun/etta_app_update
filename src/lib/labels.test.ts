import { describe, it, expect } from "vitest";
import { formatModuleLabel } from "./labels";

describe("formatModuleLabel", () => {
  // The v1 bug: `.slice(-1)` rendered "alg_m01" as "1" by luck, then broke for
  // any two-digit module ("alg_m10" -> "0", "alg_m12" -> "2"). Verify the
  // trailing number is parsed correctly across single- and double-digit ids.
  it("renders the real module number", () => {
    expect(formatModuleLabel("alg_m01")).toBe("Module 1");
    expect(formatModuleLabel("alg_m09")).toBe("Module 9");
    expect(formatModuleLabel("alg_m10")).toBe("Module 10");
    expect(formatModuleLabel("svc_m12")).toBe("Module 12");
  });

  it("falls back to the raw id for an unrecognized shape", () => {
    expect(formatModuleLabel("weird")).toBe("weird");
  });
});
