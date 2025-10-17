import { describe, expect, it, beforeEach } from "vitest";
import {
  clearLastDeviceId,
  loadAutoReconnect,
  loadLastDeviceId,
  loadPresets,
  loadUnit,
  saveAutoReconnect,
  saveLastDeviceId,
  savePresets,
  saveUnit
} from "../storage";
import type { Preset } from "../store";

const samplePresets: Preset[] = [
  { id: "sit", name: "坐姿", height: 110 },
  { id: "stand", name: "站姿", height: 120 }
];

describe("storage helpers (memory fallback)", () => {
  beforeEach(() => {
    savePresets([]);
    saveUnit("cm");
    saveAutoReconnect(true);
    clearLastDeviceId();
  });

  it("persists presets", () => {
    savePresets(samplePresets);
    expect(loadPresets()).toEqual(samplePresets);
  });

  it("persists unit preference", () => {
    saveUnit("inch");
    expect(loadUnit()).toBe("inch");
  });

  it("persists auto reconnect flag", () => {
    saveAutoReconnect(false);
    expect(loadAutoReconnect()).toBe(false);
  });

  it("persists last connected device id", () => {
    expect(loadLastDeviceId()).toBeNull();
    saveLastDeviceId("device-123");
    expect(loadLastDeviceId()).toBe("device-123");
    clearLastDeviceId();
    expect(loadLastDeviceId()).toBeNull();
  });
});
