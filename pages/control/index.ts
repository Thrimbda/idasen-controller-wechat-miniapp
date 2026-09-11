import { bindPageTheme } from "../../utils/page-theme";
import { getAppStore } from "../../utils/app-context";
import { formatHeight, formatSpeed } from "../../utils/format";
import { getDeskService } from "../../utils/desk-service";
import { DEFAULT_TOLERANCE } from "../../utils/desk-protocol";
import {
  getDeskDisplayName,
  SIT_PRESET_ID,
  STAND_PRESET_ID,
} from "../../utils/store";
import type { AppState, Preset, RememberedDesk } from "../../utils/store";
import type { MovementCommand } from "../../utils/desk-protocol";
import {
  recordManualMove,
  recordPresetUse,
  recordSettingsOpen,
} from "../../utils/analytics";

const store = getAppStore();
const deskService = getDeskService();

type ActivePreset = "" | "sit" | "stand";

type DeskOption = {
  deviceId: string;
  name: string;
};

type PageData = {
  connected: boolean;
  isSwitching: boolean;
  activeDeskName: string;
  deskNames: string[];
  activeDeskIndex: number;
  hasMultipleDesks: boolean;
  currentHeight: string;
  currentSpeed: string;
  heightValue: string;
  targetHeightDisplay: string;
  unit: "cm" | "inch";
  sitPresetHeight: string;
  standPresetHeight: string;
  pendingCommand: MovementCommand;
  isAutoMoving: boolean;
  activePreset: ActivePreset;
};

const findPreset = (
  presets: Preset[],
  id: string,
  fallbackName: string,
): Preset | null => {
  const byId = presets.find((preset) => preset.id === id);
  if (byId) {
    return byId;
  }
  return presets.find((preset) => preset.name === fallbackName) ?? null;
};

Page({
  data: {
    connected: false,
    isSwitching: false,
    activeDeskName: "",
    deskNames: [],
    activeDeskIndex: 0,
    hasMultipleDesks: false,
    currentHeight: "--",
    currentSpeed: "--",
    heightValue: "--",
    targetHeightDisplay: "--",
    unit: "cm",
    sitPresetHeight: "--",
    standPresetHeight: "--",
    pendingCommand: "stop" as MovementCommand,
    isAutoMoving: false,
    activePreset: "",
  } as PageData,

  unsubscribe: null as null | (() => void),
  unbindTheme: null as null | (() => void),
  holdCommand: null as MovementCommand | null,
  manualTouchStartAt: null as number | null,
  sitPreset: null as Preset | null,
  standPreset: null as Preset | null,
  deskOptions: [] as DeskOption[],

  onLoad() {
    this.unbindTheme = bindPageTheme();
    this.unsubscribe = store.subscribe((state) => this.applyState(state));
    this.applyState(store.getState());
  },

  onUnload() {
    this.unbindTheme?.();
    this.unbindTheme = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.holdCommand = null;
    this.manualTouchStartAt = null;
  },

  applyState(state: AppState) {
    this.sitPreset = findPreset(state.presets, SIT_PRESET_ID, "坐下");
    this.standPreset = findPreset(state.presets, STAND_PRESET_ID, "站立");

    const activePreset = this.resolveActivePreset(state);
    const deskOptions = this.toDeskOptions(state.rememberedDesks);
    const displayDeskId =
      state.pendingDeskId ?? state.connectedDeviceId ?? state.activeDeskId;
    const activeDeskIndex = Math.max(
      0,
      deskOptions.findIndex((desk) => desk.deviceId === displayDeskId),
    );
    const activeDesk = state.rememberedDesks.find(
      (desk) => desk.deviceId === displayDeskId,
    );
    this.deskOptions = deskOptions;

    this.setData({
      connected: !!state.connectedDeviceId && !state.isConnecting,
      isSwitching: state.isConnecting,
      activeDeskName: activeDesk ? getDeskDisplayName(activeDesk) : "",
      deskNames: deskOptions.map((desk) => desk.name),
      activeDeskIndex,
      hasMultipleDesks: deskOptions.length > 1,
      currentHeight: formatHeight(state.currentHeight, state.unit),
      currentSpeed: formatSpeed(state.lastKnownSpeed),
      heightValue: formatHeight(state.currentHeight, state.unit).split(" ")[0],
      targetHeightDisplay: formatHeight(state.targetHeight, state.unit),
      unit: state.unit,
      sitPresetHeight: this.sitPreset
        ? formatHeight(this.sitPreset.height, state.unit)
        : "--",
      standPresetHeight: this.standPreset
        ? formatHeight(this.standPreset.height, state.unit)
        : "--",
      pendingCommand: state.pendingCommand,
      isAutoMoving: state.targetHeight !== null,
      activePreset,
    });
  },

  resolveActivePreset(state: AppState): ActivePreset {
    if (state.targetHeight === null) {
      return "";
    }

    if (
      this.sitPreset &&
      Math.abs(state.targetHeight - this.sitPreset.height) <= DEFAULT_TOLERANCE
    ) {
      return "sit";
    }

    if (
      this.standPreset &&
      Math.abs(state.targetHeight - this.standPreset.height) <=
        DEFAULT_TOLERANCE
    ) {
      return "stand";
    }

    return "";
  },

  toDeskOptions(desks: RememberedDesk[]): DeskOption[] {
    const baseNames = desks.map((desk) => getDeskDisplayName(desk));
    const counts = baseNames.reduce<Record<string, number>>((result, name) => {
      result[name] = (result[name] ?? 0) + 1;
      return result;
    }, {});
    const occurrences: Record<string, number> = {};

    return desks.map((desk, index) => {
      const baseName = baseNames[index];
      occurrences[baseName] = (occurrences[baseName] ?? 0) + 1;
      return {
        deviceId: desk.deviceId,
        name:
          counts[baseName] > 1
            ? `${baseName} · ${occurrences[baseName]}`
            : baseName,
      };
    });
  },

  navigateToConnection() {
    wx.navigateTo({
      url: this.data.connected
        ? "/pages/connection/index?manage=1"
        : "/pages/connection/index",
    });
  },

  navigateToSettings() {
    recordSettingsOpen("control");
    wx.navigateTo({ url: "/pages/settings/index" });
  },

  async onDeskPickerChange(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    const desk = this.deskOptions[index];
    if (!desk || desk.deviceId === store.getState().connectedDeviceId) {
      return;
    }

    try {
      await deskService.selectDesk(desk.deviceId);
      wx.showToast({ title: `已切换到${desk.name}`, icon: "none" });
    } catch (error) {
      console.error("Failed to switch desk", error);
      wx.showToast({ title: "切换失败，请检查桌子连接", icon: "none" });
    }
  },

  async onControlTouchStart(event: WechatMiniprogram.TouchEvent) {
    const command = event.currentTarget.dataset.command as
      MovementCommand | undefined;
    if (!command || command === "stop" || !this.data.connected) {
      return;
    }

    if (this.holdCommand === command) {
      return;
    }

    this.holdCommand = command;
    this.manualTouchStartAt = Date.now();
    try {
      await deskService.sendCommand(command);
    } catch (error) {
      this.holdCommand = null;
      this.manualTouchStartAt = null;
      console.error("Failed to send manual command", error);
      wx.showToast({ title: "指令失败", icon: "none" });
    }
  },

  async onControlTouchEnd() {
    if (!this.holdCommand) {
      return;
    }

    const direction = this.holdCommand;
    this.holdCommand = null;
    const duration =
      this.manualTouchStartAt !== null
        ? Date.now() - this.manualTouchStartAt
        : 0;
    this.manualTouchStartAt = null;

    try {
      await deskService.sendCommand("stop");
      if (direction === "up" || direction === "down") {
        recordManualMove(direction, duration);
      }
    } catch (error) {
      console.error("Failed to stop manual movement", error);
    }
  },

  onControlTouchCancel() {
    void this.onControlTouchEnd();
  },

  async onManualStop() {
    if (!this.data.connected) {
      return;
    }
    this.holdCommand = null;
    this.manualTouchStartAt = null;
    try {
      await deskService.sendCommand("stop");
    } catch (error) {
      console.error("Failed to stop", error);
      wx.showToast({ title: "停止失败", icon: "none" });
    }
  },

  onPresetAction(event: WechatMiniprogram.TouchEvent) {
    const target = event.currentTarget.dataset.target as
      ActivePreset | undefined;
    if (target && this.data.activePreset === target) {
      void this.onPresetStop(event);
    } else {
      void this.onPresetTap(event);
    }
  },

  async onPresetTap(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.connected) {
      wx.showToast({ title: "请先连接桌子", icon: "none" });
      return;
    }

    const target = event.currentTarget.dataset.target as
      ActivePreset | undefined;
    const preset = target === "sit" ? this.sitPreset : this.standPreset;

    if (!target || !preset) {
      wx.showToast({ title: "预设未配置", icon: "none" });
      return;
    }

    try {
      await deskService.moveToHeight(preset.height);
      wx.showToast({ title: target === "sit" ? "坐下" : "站立", icon: "none" });
      recordPresetUse(target, preset.height);
    } catch (error) {
      console.error("Failed to move to preset", error);
      wx.showToast({ title: "移动失败", icon: "none" });
    }
  },

  async onPresetStop(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.connected) {
      return;
    }

    const target = event.currentTarget.dataset.target as
      ActivePreset | undefined;

    try {
      await deskService.cancelTarget();
      await deskService.sendCommand("stop");
      if (target) {
        wx.showToast({
          title: `${target === "sit" ? "坐下" : "站立"}已停止`,
          icon: "none",
        });
      } else {
        wx.showToast({ title: "已停止", icon: "none" });
      }
    } catch (error) {
      console.error("Failed to stop preset movement", error);
      wx.showToast({ title: "停止失败", icon: "none" });
    }
  },
});
