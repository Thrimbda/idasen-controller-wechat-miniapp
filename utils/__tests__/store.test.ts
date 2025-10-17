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
});
