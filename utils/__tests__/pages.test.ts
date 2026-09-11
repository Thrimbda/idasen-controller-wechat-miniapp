import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createAppStore, type AppStore } from "../store";

const mocks = vi.hoisted(() => ({
  store: null as AppStore | null,
  service: {
    startScan: vi.fn(),
    stopScan: vi.fn(),
    selectDesk: vi.fn(),
    sendCommand: vi.fn(),
    moveToHeight: vi.fn(),
    cancelTarget: vi.fn(),
  },
  savePresets: vi.fn(),
}));
vi.mock("../app-context", () => ({ getAppStore: () => mocks.store }));
vi.mock("../desk-service", () => ({ getDeskService: () => mocks.service }));
vi.mock("../storage", () => ({
  savePresets: mocks.savePresets,
  saveUnit: vi.fn(),
  saveAutoReconnect: vi.fn(),
}));
vi.mock("../analytics", () => ({
  recordPresetSaved: vi.fn(),
  recordUnitSwitch: vi.fn(),
  recordManualMove: vi.fn(),
  recordPresetUse: vi.fn(),
  recordSettingsOpen: vi.fn(),
  recordConnectFail: vi.fn(),
}));

// Exercise real page handlers with a store and a mocked hardware boundary.
let page: any;
const event = (target: string, value?: string) => ({
  currentTarget: { dataset: { target } },
  detail: { value },
});
async function load(name: "settings" | "control" | "connection", options = {}) {
  vi.stubGlobal("Page", (definition: any) => {
    page = { ...definition, data: { ...definition.data } };
    page.setData = (patch: object) => Object.assign(page.data, patch);
  });
  if (name === "settings") await import("../../pages/settings/index");
  if (name === "control") await import("../../pages/control/index");
  if (name === "connection") await import("../../pages/connection/index");
  page.onLoad(options);
  return page;
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.store = createAppStore();
  vi.stubGlobal("wx", {
    getAppBaseInfo: () => ({ theme: "light" }),
    setNavigationBarColor: vi.fn(),
    setBackgroundColor: vi.fn(),
    onThemeChange: vi.fn(),
    offThemeChange: vi.fn(),
    showToast: vi.fn(),
    navigateTo: vi.fn(),
    reLaunch: vi.fn(),
  });
});
afterEach(() => {
  page?.onUnload?.();
  vi.unstubAllGlobals();
});

describe("settings page drafts", () => {
  it("updates native chrome on theme change without losing a draft", async () => {
    await load("settings");
    page.onPresetInput(event("sit", "75.5"));
    const listener = vi.mocked(wx.onThemeChange).mock.calls[0][0];
    listener({ theme: "dark" });
    expect(wx.setNavigationBarColor).toHaveBeenLastCalledWith({
      frontColor: "#ffffff",
      backgroundColor: "#20221e",
    });
    expect(page.data.sitHeightInput).toBe("75.5");
    expect(page.data.controlColor).toBe("#727a66");
  });

  it("preserves both drafts across device notifications and saving the other preset", async () => {
    await load("settings");
    page.onPresetInput(event("sit", "75.5"));
    page.onPresetInput(event("stand", "112.0"));
    mocks.store!.setState({ currentHeight: 86.2 });
    expect(page.data.sitHeightInput).toBe("75.5");
    await page.onSavePreset(event("stand"));
    expect(page.data.sitHeightInput).toBe("75.5");
    expect(page.data.sitDirty).toBe(true);
    expect(page.data.standSaved).toBe(true);
    expect(mocks.savePresets).toHaveBeenCalledOnce();
  });

  it("converts an unfinished draft when switching units and saves in cm", async () => {
    await load("settings");
    page.onPresetInput(event("sit", "76.2"));
    page.onUnitChange({ detail: { value: "inch" } });
    expect(page.data.sitHeightInput).toBe("30.0");
    expect(page.data.sitDirty).toBe(true);
    await page.onSavePreset(event("sit"));
    expect(
      mocks.store!.getState().presets.find((p) => p.id === "preset-sit")
        ?.height,
    ).toBe(76.2);
  });

  it.each(["", "0", "-1", "abc", "72cm"])(
    "retains invalid input %s and reports a field error",
    async (value) => {
      await load("settings");
      page.onPresetInput(event("sit", value));
      await page.onSavePreset(event("sit"));
      expect(page.data.sitError).not.toBe("");
      expect(page.data.sitHeightInput).toBe(value);
      expect(mocks.savePresets).not.toHaveBeenCalled();
    },
  );

  it("retains draft and saved state when persistence fails", async () => {
    await load("settings");
    mocks.savePresets.mockImplementationOnce(() => {
      throw new Error("storage full");
    });
    page.onPresetInput(event("sit", "75.0"));
    await page.onSavePreset(event("sit"));
    expect(page.data.sitHeightInput).toBe("75.0");
    expect(page.data.sitSaved).toBe(false);
    expect(page.data.sitError).toContain("保存失败");
    expect(mocks.store!.getState().presets[0].height).toBe(72);
  });

  it("does not offer a stale height while disconnected or switching desks", async () => {
    mocks.store!.setState({ currentHeight: 80 });
    await load("settings");
    expect(page.data.canUseCurrentHeight).toBe(false);
    mocks.store!.setState({ connectedDeviceId: "desk", isConnecting: true });
    expect(page.data.canUseCurrentHeight).toBe(false);
    mocks.store!.setState({ isConnecting: false });
    expect(page.data.canUseCurrentHeight).toBe(true);
  });
});

describe("control page", () => {
  it("keeps the active preset as a stop action and exposes an independent stop", async () => {
    mocks.store!.setState({
      connectedDeviceId: "desk",
      currentHeight: 90,
      targetHeight: 110,
    });
    await load("control");
    page.onPresetAction(event("stand"));
    await vi.waitFor(() =>
      expect(mocks.service.sendCommand).toHaveBeenCalledWith("stop"),
    );
    expect(mocks.service.cancelTarget).toHaveBeenCalledOnce();
    expect(mocks.service.moveToHeight).not.toHaveBeenCalled();
    await page.onManualStop();
    expect(mocks.service.sendCommand).toHaveBeenLastCalledWith("stop");
  });

  it("opens normal connection onboarding when offline and management when connected", async () => {
    await load("control");
    page.navigateToConnection();
    expect(wx.navigateTo).toHaveBeenLastCalledWith({
      url: "/pages/connection/index",
    });
    mocks.store!.setState({ connectedDeviceId: "desk" });
    page.navigateToConnection();
    expect(wx.navigateTo).toHaveBeenLastCalledWith({
      url: "/pages/connection/index?manage=1",
    });
  });

  it("stops manual movement on touch cancellation", async () => {
    mocks.store!.setState({ connectedDeviceId: "desk" });
    await load("control");
    await page.onControlTouchStart({
      currentTarget: { dataset: { command: "up" } },
    });
    page.onControlTouchCancel();
    await vi.waitFor(() =>
      expect(mocks.service.sendCommand).toHaveBeenLastCalledWith("stop"),
    );
  });

  it("does not send a movement command while disconnected", async () => {
    await load("control");
    await page.onControlTouchStart({
      currentTarget: { dataset: { command: "up" } },
    });
    await page.onPresetTap(event("sit"));
    expect(mocks.service.sendCommand).not.toHaveBeenCalled();
    expect(mocks.service.moveToHeight).not.toHaveBeenCalled();
  });
});

describe("connection page", () => {
  it("allows device management while connected", async () => {
    mocks.store!.setState({
      connectedDeviceId: "desk",
      rememberedDesks: [{ deviceId: "desk", deviceName: "Desk" }],
    });
    await load("connection", { manage: "1" });
    expect(wx.reLaunch).not.toHaveBeenCalled();
    expect(page.data.rememberedDesks[0].isCurrent).toBe(true);
  });

  it("marks only the selected discovery result as connecting", async () => {
    mocks.store!.setState({
      isConnecting: true,
      pendingDeskId: "b",
      availableDevices: [
        { deviceId: "a", name: "A", RSSI: -40 },
        { deviceId: "b", name: "B", RSSI: -60 },
      ],
    });
    await load("connection", { manage: "1" });
    expect(page.data.deviceCount).toBe(2);
    expect(page.data.devices.map((device: any) => device.isConnecting)).toEqual(
      [false, true],
    );
  });

  it("shows a recoverable error when scanning fails", async () => {
    mocks.service.startScan.mockRejectedValue(new Error("bluetooth off"));
    await load("connection");
    await vi.waitFor(() =>
      expect(page.data.errorMessage).toContain("扫描失败"),
    );
    mocks.service.startScan.mockResolvedValue(undefined);
    await page.startScan();
    expect(page.data.errorMessage).toBe("");
  });
});
