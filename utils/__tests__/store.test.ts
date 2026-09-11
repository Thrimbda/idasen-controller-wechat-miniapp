import { describe, expect, it } from "vitest";
import { createAppStore } from "../store";

describe("store", () => {
  it("updates state and notifies listeners", () => {
    const store = createAppStore();
    let observed = store.getState();

    const unsubscribe = store.subscribe((state) => {
      observed = state;
    });

    store.setState({ connectedDeviceId: "device-1" });

    expect(observed.connectedDeviceId).toBe("device-1");
    unsubscribe();
  });

  it("resets to default state", () => {
    const store = createAppStore();
    store.setState({ connectedDeviceId: "device-2" });
    store.reset();
    expect(store.getState().connectedDeviceId).toBeNull();
  });

  it("keeps remembered desk records immutable across state updates", () => {
    const desks = [{ deviceId: "desk-a", deviceName: "Desk A", nickname: "书房桌" }];
    const store = createAppStore({ rememberedDesks: desks, activeDeskId: "desk-a" });

    desks[0].nickname = "外部修改";
    store.setState({ rememberedDesks: [{ deviceId: "desk-b", deviceName: "Desk B" }] });

    expect(store.getState().rememberedDesks).toEqual([{
      deviceId: "desk-b",
      deviceName: "Desk B"
    }]);
    store.reset();
    expect(store.getState().rememberedDesks).toEqual([]);
    expect(store.getState().activeDeskId).toBeNull();
  });
});
