import { describe, expect, it } from "vitest";
import { convertHeight, formatHeight, formatSpeed } from "../format";

describe("format utils", () => {
  it("converts cm to inch", () => {
    expect(convertHeight(100, "cm", "inch")).toBeCloseTo(39.37, 2);
  });

  it("converts inch to cm", () => {
    expect(convertHeight(10, "inch", "cm")).toBeCloseTo(25.4, 1);
  });

  it("formats height with unit", () => {
    expect(formatHeight(110.345, "cm")).toBe("110.3 cm");
    expect(formatHeight(110.345, "inch", 2)).toBe("43.44 inch");
  });

  it("handles null height", () => {
    expect(formatHeight(null, "cm")).toBe("--");
  });

  it("formats speed", () => {
    expect(formatSpeed(2.456)).toBe("2.46 cm/s");
    expect(formatSpeed(null)).toBe("--");
  });
});
