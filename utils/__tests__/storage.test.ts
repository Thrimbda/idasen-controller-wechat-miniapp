import { describe, expect, it, beforeEach } from "vitest";
import {
  clearActiveDeskId,
  clearLastDeviceId,
  loadActiveDeskId,
  loadAutoReconnect,
  loadLastDeviceId,
  loadRememberedDeskDirectory,
  loadRememberedDesks,
  loadPresets,
  loadUnit,
  normalizeRememberedDesks,
  saveActiveDeskId,
  saveAutoReconnect,
  saveConfirmedDeskDirectory,
  saveLastDeviceId,
  saveRememberedDesks,
  savePresets,
  saveUnit
} from "../storage";
import type { Preset, RememberedDesk } from "../store";

const samplePresets: Preset[] = [
  { id: "sit", name: "坐姿", height: 110 },
  { id: "stand", name: "站姿", height: 120 }
];

const sampleDesks: RememberedDesk[] = [
  { deviceId: "desk-a", deviceName: "Desk A", nickname: "书房桌" },
  { deviceId: "desk-b", deviceName: "Desk B" }
];

describe("storage helpers (memory fallback)", () => {
  beforeEach(() => {
    savePresets([]);
    saveUnit("cm");
    saveAutoReconnect(true);
    clearLastDeviceId();
    clearActiveDeskId();
    saveRememberedDesks([]);
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

  it("persists remembered desks and the confirmed active desk in compatibility order", () => {
    saveConfirmedDeskDirectory(sampleDesks, "desk-b");

    expect(loadRememberedDesks()).toEqual(sampleDesks);
    expect(loadActiveDeskId()).toBe("desk-b");
    expect(loadLastDeviceId()).toBe("desk-b");
  });

  it("migrates a legacy device id into a remembered desk directory", () => {
    saveLastDeviceId("legacy-desk");

    expect(loadRememberedDeskDirectory()).toEqual({
      rememberedDesks: [
        { deviceId: "legacy-desk", deviceName: "已记住的桌子" }
      ],
      activeDeskId: "legacy-desk"
    });
    expect(loadRememberedDesks()).toHaveLength(1);
    expect(loadActiveDeskId()).toBe("legacy-desk");
  });

  it("normalizes invalid and duplicate remembered desk records without losing a nickname", () => {
    expect(
      normalizeRememberedDesks([
        null,
        { deviceId: " ", deviceName: "ignored" },
        { deviceId: "desk-a", deviceName: "" },
        { deviceId: "desk-a", deviceName: "Desk A", nickname: "书房桌" }
      ])
    ).toEqual([{ deviceId: "desk-a", deviceName: "Desk A", nickname: "书房桌" }]);
  });

  it("repairs a missing active desk with the legacy successful desk", () => {
    saveRememberedDesks(sampleDesks);
    saveLastDeviceId("desk-a");
    saveActiveDeskId("missing-desk");

    expect(loadRememberedDeskDirectory().activeDeskId).toBe("desk-a");
    expect(loadActiveDeskId()).toBe("desk-a");
  });
});
