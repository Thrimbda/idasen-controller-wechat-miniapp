export const POSITION_SERVICE_UUID = "99FA0020-338A-1024-8A49-009C0215F78A";
export const POSITION_CHARACTERISTIC_UUID = "99FA0021-338A-1024-8A49-009C0215F78A";
export const CONTROL_SERVICE_UUID = "99FA0001-338A-1024-8A49-009C0215F78A";
export const CONTROL_CHARACTERISTIC_UUID = "99FA0002-338A-1024-8A49-009C0215F78A";

export const HEIGHT_OFFSET = 61.5;
export const DEFAULT_TOLERANCE = 0.1;

export type MovementCommand = "up" | "down" | "stop";

const commandPayload: Record<MovementCommand, Uint8Array> = {
  up: Uint8Array.from([0x47, 0x00]),
  down: Uint8Array.from([0x46, 0x00]),
  stop: Uint8Array.from([0xff, 0x00])
};

export interface PositionSnapshot {
  height: number;
  speed: number;
  rawHeight: number;
  rawSpeed: number;
}

const toDataView = (input: ArrayBufferLike | DataView | Uint8Array): DataView => {
  if (input instanceof DataView) {
    return input;
  }

  if (input instanceof Uint8Array) {
    return new DataView(input.buffer, input.byteOffset, input.byteLength);
  }

  return new DataView(input);
};

export const decodePositionSnapshot = (
  payload: ArrayBufferLike | DataView | Uint8Array
): PositionSnapshot => {
  const view = toDataView(payload);
  if (view.byteLength < 4) {
    throw new Error("Position payload too short");
  }

  const rawHeight = view.getUint16(0, true);
  const rawSpeed = view.getInt16(2, true);

  return {
    rawHeight,
    rawSpeed,
    height: rawHeight / 100 + HEIGHT_OFFSET,
    speed: rawSpeed / 100
  };
};

export const encodeCommand = (command: MovementCommand): ArrayBuffer => {
  const data = commandPayload[command];
  return data.slice().buffer;
};

export const isWithinTolerance = (
  currentHeight: number,
  targetHeight: number,
  tolerance: number = DEFAULT_TOLERANCE
): boolean => Math.abs(currentHeight - targetHeight) <= tolerance;

export const determineMovementCommand = (
  currentHeight: number,
  targetHeight: number,
  tolerance: number = DEFAULT_TOLERANCE
): MovementCommand => {
  if (isWithinTolerance(currentHeight, targetHeight, tolerance)) {
    return "stop";
  }

  return targetHeight > currentHeight ? "up" : "down";
};
