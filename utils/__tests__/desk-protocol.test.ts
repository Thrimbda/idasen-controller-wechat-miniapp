import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOLERANCE,
  HEIGHT_OFFSET,
  decodePositionSnapshot,
  determineMovementCommand,
  encodeCommand,
  isWithinTolerance
} from "../desk-protocol";

const createPayload = (heightRaw: number, speedRaw: number) => {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint16(0, heightRaw, true);
  view.setInt16(2, speedRaw, true);
  return buffer;
};

describe("desk-protocol", () => {
  it("decodes position payload correctly", () => {
    const payload = createPayload(5000, 300);
    const snapshot = decodePositionSnapshot(payload);
    expect(snapshot.height).toBeCloseTo(HEIGHT_OFFSET + 50, 1);
    expect(snapshot.speed).toBeCloseTo(3);
    expect(snapshot.rawHeight).toBe(5000);
    expect(snapshot.rawSpeed).toBe(300);
  });

  it("throws when payload too short", () => {
    const buffer = new ArrayBuffer(2);
    expect(() => decodePositionSnapshot(buffer)).toThrowError("Position payload too short");
  });

  it("encodes commands into ArrayBuffer", () => {
    const upBuffer = encodeCommand("up");
    const bytes = new Uint8Array(upBuffer);
    expect(Array.from(bytes)).toEqual([0x47, 0x00]);
  });

  it("determines movement command based on tolerance", () => {
    const command = determineMovementCommand(100, 120);
    expect(command).toBe("up");

    const stopCommand = determineMovementCommand(100, 100.05, DEFAULT_TOLERANCE);
    expect(stopCommand).toBe("stop");
    expect(determineMovementCommand(100, 100.2, DEFAULT_TOLERANCE)).toBe("up");
    expect(determineMovementCommand(100, 99.8, DEFAULT_TOLERANCE)).toBe("down");
  });

  it("checks tolerance correctly", () => {
    expect(isWithinTolerance(100, 100.05, DEFAULT_TOLERANCE)).toBe(true);
    expect(isWithinTolerance(100, 99.95, DEFAULT_TOLERANCE)).toBe(true);
    expect(isWithinTolerance(100, 100.2, DEFAULT_TOLERANCE)).toBe(false);
    expect(isWithinTolerance(100, 99.8, DEFAULT_TOLERANCE)).toBe(false);
    expect(isWithinTolerance(100, 100.4, 0.5)).toBe(true);
  });
});
