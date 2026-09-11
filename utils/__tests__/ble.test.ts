import { afterEach, describe, expect, it, vi } from "vitest";
import { DeskBleClient } from "../ble";
import {
  CONTROL_CHARACTERISTIC_UUID,
  POSITION_CHARACTERISTIC_UUID,
  POSITION_SERVICE_UUID
} from "../desk-protocol";

type ConnectionCallback = (payload: { deviceId: string; connected: boolean }) => void;
type CharacteristicCallback = (payload: {
  deviceId: string;
  serviceId: string;
  characteristicId: string;
  value: ArrayBuffer;
}) => void;

type MockOptions = {
  closeFails?: boolean;
  discoverFails?: boolean;
  emitRawTrueDuringDiscovery?: boolean;
};

const installWx = (options: MockOptions = {}) => {
  let connectionCallback: ConnectionCallback | undefined;
  let characteristicCallback: CharacteristicCallback | undefined;
  const closeBLEConnection = vi.fn((callbackOptions: { success: (value: unknown) => void; fail: (error: unknown) => void }) => {
    if (options.closeFails) {
      callbackOptions.fail({ errMsg: "closeBLEConnection:fail" });
      return;
    }
    callbackOptions.success({});
  });

  const wxMock = {
    onBluetoothAdapterStateChange: vi.fn(),
    onBluetoothDeviceFound: vi.fn(),
    onBLEConnectionStateChange: vi.fn((callback: ConnectionCallback) => {
      connectionCallback = callback;
    }),
    onBLECharacteristicValueChange: vi.fn((callback: CharacteristicCallback) => {
      characteristicCallback = callback;
    }),
    openBluetoothAdapter: vi.fn((callbackOptions: { success: (value: unknown) => void }) => callbackOptions.success({})),
    startBluetoothDevicesDiscovery: vi.fn((callbackOptions: { success: (value: unknown) => void }) => callbackOptions.success({})),
    stopBluetoothDevicesDiscovery: vi.fn((callbackOptions: { success: (value: unknown) => void }) => callbackOptions.success({})),
    createBLEConnection: vi.fn((callbackOptions: { success: (value: unknown) => void }) => callbackOptions.success({})),
    closeBLEConnection,
    getBLEDeviceServices: vi.fn((callbackOptions: {
      deviceId: string;
      success: (value: unknown) => void;
      fail: (error: unknown) => void;
    }) => {
      if (options.emitRawTrueDuringDiscovery) {
        connectionCallback?.({ deviceId: callbackOptions.deviceId, connected: true });
      }
      if (options.discoverFails) {
        callbackOptions.fail({ errMsg: "getBLEDeviceServices:fail" });
        return;
      }
      callbackOptions.success({ services: [{ uuid: POSITION_SERVICE_UUID }] });
    }),
    getBLEDeviceCharacteristics: vi.fn((callbackOptions: { success: (value: unknown) => void }) => {
      callbackOptions.success({
        characteristics: [
          { uuid: POSITION_CHARACTERISTIC_UUID, properties: {} },
          { uuid: CONTROL_CHARACTERISTIC_UUID, properties: {} }
        ]
      });
    }),
    writeBLECharacteristicValue: vi.fn(),
    notifyBLECharacteristicValueChange: vi.fn(),
    readBLECharacteristicValue: vi.fn()
  };

  (globalThis as { wx?: unknown }).wx = wxMock;
  return {
    closeBLEConnection,
    createBLEConnection: wxMock.createBLEConnection,
    getBLEDeviceServices: wxMock.getBLEDeviceServices,
    emitConnectionState: (payload: { deviceId: string; connected: boolean }) =>
      connectionCallback?.(payload),
    emitCharacteristic: (payload: Parameters<CharacteristicCallback>[0]) =>
      characteristicCallback?.(payload)
  };
};

const createPositionBuffer = (rawHeight = 1000, rawSpeed = 0): ArrayBuffer => {
  const value = new ArrayBuffer(4);
  const view = new DataView(value);
  view.setUint16(0, rawHeight, true);
  view.setInt16(2, rawSpeed, true);
  return value;
};

afterEach(() => {
  delete (globalThis as { wx?: unknown }).wx;
});

describe("DeskBleClient lifecycle", () => {
  it("keeps raw transport connected separate from app-ready connection", async () => {
    installWx({ emitRawTrueDuringDiscovery: true });
    const client = new DeskBleClient();
    const events: Array<{ deviceId: string; connected: boolean; ready?: boolean }> = [];
    client.on("connectionState", (event) => events.push(event));

    await client.connect("desk-a");

    expect(events).toEqual([{ deviceId: "desk-a", connected: true, ready: true }]);
  });

  it("closes a candidate when service discovery fails without reporting it as ready", async () => {
    const mock = installWx({ discoverFails: true });
    const client = new DeskBleClient();
    const events: Array<{ deviceId: string; connected: boolean; ready?: boolean }> = [];
    client.on("connectionState", (event) => events.push(event));

    await expect(client.connect("desk-a")).rejects.toMatchObject({
      errMsg: "getBLEDeviceServices:fail"
    });

    expect(mock.closeBLEConnection).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ deviceId: "desk-a", connected: false }]);
  });

  it("does not fake a disconnect when close fails", async () => {
    const mock = installWx({ closeFails: true });
    const client = new DeskBleClient();
    const events: Array<{ deviceId: string; connected: boolean; ready?: boolean }> = [];
    client.on("connectionState", (event) => events.push(event));
    await client.connect("desk-a");

    await expect(client.disconnect()).rejects.toMatchObject({ errMsg: "closeBLEConnection:fail" });
    expect(mock.closeBLEConnection).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ deviceId: "desk-a", connected: true, ready: true }]);
    await expect(client.connect("desk-b")).rejects.toThrow("still active");
  });

  it("keeps a failed discovery candidate active when its cleanup close fails", async () => {
    const mock = installWx({
      closeFails: true,
      discoverFails: true,
      emitRawTrueDuringDiscovery: true
    });
    const client = new DeskBleClient();
    const events: Array<{ deviceId: string; connected: boolean; ready?: boolean }> = [];
    client.on("connectionState", (event) => events.push(event));

    await expect(client.connect("desk-b")).rejects.toMatchObject({
      errMsg: "closeBLEConnection:fail"
    });

    expect(mock.closeBLEConnection).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    await expect(client.connect("desk-c")).rejects.toThrow("still active");
    expect(mock.createBLEConnection).toHaveBeenCalledTimes(1);
  });

  it("emits one disconnect when the close callback and raw event both arrive", async () => {
    const mock = installWx();
    const client = new DeskBleClient();
    const events: Array<{ deviceId: string; connected: boolean; ready?: boolean }> = [];
    client.on("connectionState", (event) => events.push(event));
    await client.connect("desk-a");

    await client.disconnect();
    mock.emitConnectionState({ deviceId: "desk-a", connected: false });

    expect(events).toEqual([
      { deviceId: "desk-a", connected: true, ready: true },
      { deviceId: "desk-a", connected: false }
    ]);
  });

  it("ignores stale characteristic data from the old desk after a switch", async () => {
    const mock = installWx();
    const client = new DeskBleClient();
    const positions: Array<{ deviceId: string; height: number }> = [];
    const errors: unknown[] = [];
    client.on("position", (event) => positions.push(event));
    client.on("error", (event) => errors.push(event));

    await client.connect("desk-a");
    await client.disconnect();
    await client.connect("desk-b");
    mock.emitCharacteristic({
      deviceId: "desk-a",
      serviceId: POSITION_SERVICE_UUID,
      characteristicId: POSITION_CHARACTERISTIC_UUID,
      value: new ArrayBuffer(1)
    });
    mock.emitCharacteristic({
      deviceId: "desk-b",
      serviceId: POSITION_SERVICE_UUID,
      characteristicId: POSITION_CHARACTERISTIC_UUID,
      value: createPositionBuffer()
    });

    expect(positions).toMatchObject([{ deviceId: "desk-b", height: 71.5 }]);
    expect(errors).toEqual([]);
  });
});
