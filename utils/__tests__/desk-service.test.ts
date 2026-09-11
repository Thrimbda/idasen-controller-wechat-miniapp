import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeskService, type DeskBlePort } from "../desk-service";
import type { DeskBleEventMap } from "../ble";
import { createAppStore } from "../store";
import {
  clearActiveDeskId,
  clearLastDeviceId,
  loadLastDeviceId,
  loadRememberedDesks,
  saveConfirmedDeskDirectory,
  saveRememberedDesks
} from "../storage";
import type { MovementCommand } from "../desk-protocol";

class TraceBle implements DeskBlePort {
  private readonly listeners = new Map<keyof DeskBleEventMap, Set<(payload: unknown) => void>>();
  trace: string[] = [];
  currentDeviceId: string | null;
  failStop = false;
  failDisconnect = false;
  failConnect = false;
  emitRawTrueBeforeFail = false;
  deferConnect = false;
  private resolveDeferredConnect: (() => void) | null = null;

  constructor(currentDeviceId: string | null = null) {
    this.currentDeviceId = currentDeviceId;
  }

  on<K extends keyof DeskBleEventMap>(
    event: K,
    listener: (payload: DeskBleEventMap[K]) => void
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set<(payload: unknown) => void>();
    listeners.add(listener as unknown as (payload: unknown) => void);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener as unknown as (payload: unknown) => void);
  }

  emit<K extends keyof DeskBleEventMap>(event: K, payload: DeskBleEventMap[K]) {
    this.listeners.get(event)?.forEach((listener) => listener(payload));
  }

  async startScan(): Promise<void> {
    this.trace.push("scan:start");
  }

  async stopScan(): Promise<void> {
    this.trace.push("scan:stop");
  }

  async connect(deviceId: string): Promise<void> {
    this.trace.push(`connect:${deviceId}`);
    if (this.deferConnect) {
      await new Promise<void>((resolve) => {
        this.resolveDeferredConnect = resolve;
      });
      this.resolveDeferredConnect = null;
    }
    if (this.emitRawTrueBeforeFail) {
      this.emit("connectionState", { deviceId, connected: true });
    }
    if (this.failConnect) {
      throw new Error("connect failed");
    }
    this.currentDeviceId = deviceId;
    this.emit("connectionState", { deviceId, connected: true, ready: true });
  }

  finishDeferredConnect() {
    this.resolveDeferredConnect?.();
  }

  async disconnect(): Promise<void> {
    this.trace.push(`disconnect:${this.currentDeviceId ?? "none"}`);
    if (this.failDisconnect) {
      throw new Error("disconnect failed");
    }
    const deviceId = this.currentDeviceId;
    this.currentDeviceId = null;
    if (deviceId) {
      this.emit("connectionState", { deviceId, connected: false });
    }
  }

  async writeCommand(command: MovementCommand): Promise<void> {
    this.trace.push(`write:${this.currentDeviceId ?? "none"}:${command}`);
    if (command === "stop" && this.failStop) {
      throw new Error("stop failed");
    }
    if (!this.currentDeviceId) {
      throw new Error("no connected desk");
    }
  }

  async subscribePosition(): Promise<void> {
    this.trace.push(`subscribe:${this.currentDeviceId ?? "none"}`);
  }
}

const rememberedDeskA = { deviceId: "desk-a", deviceName: "Desk A", nickname: "书房桌" };

const createConnectedService = () => {
  saveConfirmedDeskDirectory([rememberedDeskA], "desk-a");
  const store = createAppStore();
  const ble = new TraceBle("desk-a");
  const service = new DeskService({ store, ble, autoReconnect: false });
  store.setState({ connectedDeviceId: "desk-a" });
  return { service, store, ble };
};

describe("DeskService multi-desk switching", () => {
  beforeEach(() => {
    clearLastDeviceId();
    clearActiveDeskId();
    saveRememberedDesks([]);
  });

  it("restores the scan action after a failed scan and allows retry", async () => {
    const store = createAppStore();
    const ble = new TraceBle();
    const service = new DeskService({ store, ble, autoReconnect: false });
    const scan = vi.spyOn(ble, "startScan").mockRejectedValueOnce(new Error("bluetooth off"));

    await expect(service.startScan()).rejects.toThrow("bluetooth off");
    expect(store.getState().isScanning).toBe(false);

    await service.startScan();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(store.getState().isScanning).toBe(true);
    await service.stopScan();
    expect(store.getState().isScanning).toBe(false);
  });

  it("stops, closes, and then connects the selected desk", async () => {
    const { service, store, ble } = createConnectedService();

    await service.selectDesk("desk-b");

    expect(ble.trace).toEqual([
      "write:desk-a:stop",
      "disconnect:desk-a",
      "connect:desk-b",
      "subscribe:desk-b"
    ]);
    expect(store.getState().connectedDeviceId).toBe("desk-b");
    expect(store.getState().activeDeskId).toBe("desk-b");
    expect(loadLastDeviceId()).toBe("desk-b");
    expect(loadRememberedDesks().map((desk) => desk.deviceId)).toEqual(["desk-a", "desk-b"]);
  });

  it("does not disconnect or connect a target when stop fails", async () => {
    const { service, store, ble } = createConnectedService();
    ble.failStop = true;

    await expect(service.selectDesk("desk-b")).rejects.toThrow("stop failed");

    expect(ble.trace).toEqual(["write:desk-a:stop"]);
    expect(store.getState().connectedDeviceId).toBe("desk-a");
    expect(loadLastDeviceId()).toBe("desk-a");
    expect(loadRememberedDesks()).toEqual([rememberedDeskA]);
  });

  it("does not connect a target when close fails", async () => {
    const { service, store, ble } = createConnectedService();
    ble.failDisconnect = true;

    await expect(service.selectDesk("desk-b")).rejects.toThrow("disconnect failed");

    expect(ble.trace).toEqual(["write:desk-a:stop", "disconnect:desk-a"]);
    expect(store.getState().connectedDeviceId).toBe("desk-a");
    expect(loadLastDeviceId()).toBe("desk-a");
  });

  it("keeps the last successful directory when a scanned candidate fails", async () => {
    const { service, store, ble } = createConnectedService();
    ble.failConnect = true;
    ble.emitRawTrueBeforeFail = true;

    await expect(service.selectDesk("desk-b")).rejects.toThrow("connect failed");

    expect(ble.trace).toEqual(["write:desk-a:stop", "disconnect:desk-a", "connect:desk-b"]);
    expect(store.getState().pendingDeskId).toBeNull();
    expect(loadRememberedDesks()).toEqual([rememberedDeskA]);
    expect(loadLastDeviceId()).toBe("desk-a");
  });

  it("replaces an ID only after a user-confirmed successful connection and keeps the nickname", async () => {
    const { service, store } = createConnectedService();

    await service.selectDesk("desk-b", { replaceDeskId: "desk-a" });

    expect(store.getState().rememberedDesks).toEqual([
      { deviceId: "desk-b", deviceName: "Desk A", nickname: "书房桌" }
    ]);
    expect(loadRememberedDesks()).toEqual([
      { deviceId: "desk-b", deviceName: "Desk A", nickname: "书房桌" }
    ]);
  });

  it("ignores a stale disconnect from the old desk after a successful switch", async () => {
    const { service, store, ble } = createConnectedService();

    await service.selectDesk("desk-b");
    ble.emit("connectionState", { deviceId: "desk-a", connected: false });

    expect(store.getState().connectedDeviceId).toBe("desk-b");
    expect(store.getState().activeDeskId).toBe("desk-b");
  });

  it("ignores old position and error events after switching to a new desk", async () => {
    const { service, store, ble } = createConnectedService();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    store.setState({ currentHeight: 70, lastKnownSpeed: 0 });

    await service.moveToHeight(100);
    await service.selectDesk("desk-b");
    const traceAfterSwitch = [...ble.trace];
    ble.emit("position", {
      deviceId: "desk-a",
      height: 88,
      speed: 0.4,
      rawHeight: 2650,
      rawSpeed: 40
    });
    ble.emit("error", { message: "late error from desk-a" });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(store.getState().connectedDeviceId).toBe("desk-b");
    expect(store.getState().currentHeight).toBeNull();
    expect(store.getState().lastKnownSpeed).toBeNull();
    expect(ble.trace).toEqual(traceAfterSwitch);
    expect(errorLog).toHaveBeenCalledWith("BLE error", { message: "late error from desk-a" });
    errorLog.mockRestore();
  });

  it("rejects a second target while the first target is still connecting", async () => {
    const { service, ble } = createConnectedService();
    ble.deferConnect = true;

    const firstSwitch = service.selectDesk("desk-b");
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(service.selectDesk("desk-c")).rejects.toThrow("正在连接另一张桌子");
    expect(ble.trace).toEqual([
      "write:desk-a:stop",
      "disconnect:desk-a",
      "connect:desk-b"
    ]);

    ble.finishDeferredConnect();
    await firstSwitch;
  });
});
