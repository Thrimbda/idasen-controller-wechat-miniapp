import { afterEach, describe, expect, it, vi } from "vitest";
import { recordUnitSwitch } from "../analytics";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("analytics reporting", () => {
  it("uses the configured custom-analysis backend without invoking an uninitialized SDK", () => {
    const reportAnalytics = vi.fn();
    const obsEvent = vi.fn(() => { throw new Error("setup required"); });
    vi.stubGlobal("wx", { reportAnalytics, obs: { event: obsEvent } });

    recordUnitSwitch("cm", "inch");

    expect(reportAnalytics).toHaveBeenCalledWith("unit_switch", {
      from_unit: "cm",
      to_unit: "inch",
    });
    expect(obsEvent).not.toHaveBeenCalled();
  });

  it("keeps reporting failures from interrupting a user action", () => {
    const error = new Error("report unavailable");
    vi.stubGlobal("wx", { reportAnalytics: () => { throw error; } });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => recordUnitSwitch("inch", "cm")).not.toThrow();
    expect(warning).toHaveBeenCalledWith("Analytics report failed", "unit_switch", error);
  });
});
