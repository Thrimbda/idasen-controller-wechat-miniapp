import { getAppStore } from "../../utils/app-context";
import { formatHeight, formatSpeed } from "../../utils/format";
import { getDeskService } from "../../utils/desk-service";
import { DEFAULT_TOLERANCE } from "../../utils/desk-protocol";
import { SIT_PRESET_ID, STAND_PRESET_ID } from "../../utils/store";
import type { AppState, Preset } from "../../utils/store";
import type { MovementCommand } from "../../utils/desk-protocol";

const store = getAppStore();
const deskService = getDeskService();

type ActivePreset = "" | "sit" | "stand";

type PageData = {
  connected: boolean;
  currentHeight: string;
  currentSpeed: string;
  unit: "cm" | "inch";
  sitPresetHeight: string;
  standPresetHeight: string;
  pendingCommand: MovementCommand;
  isAutoMoving: boolean;
  activePreset: ActivePreset;
};

const findPreset = (presets: Preset[], id: string, fallbackName: string): Preset | null => {
  const byId = presets.find((preset) => preset.id === id);
  if (byId) {
    return byId;
  }
  return presets.find((preset) => preset.name === fallbackName) ?? null;
};

Page({
  data: {
    connected: false,
    currentHeight: "--",
    currentSpeed: "--",
    unit: "cm",
    sitPresetHeight: "--",
    standPresetHeight: "--",
    pendingCommand: "stop" as MovementCommand,
    isAutoMoving: false,
    activePreset: ""
  } as PageData,

  unsubscribe: null as null | (() => void),
  holdCommand: null as MovementCommand | null,
  sitPreset: null as Preset | null,
  standPreset: null as Preset | null,

  onLoad() {
    this.unsubscribe = store.subscribe((state) => this.applyState(state));
    this.applyState(store.getState());
  },

  onUnload() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.holdCommand = null;
  },

  applyState(state: AppState) {
    this.sitPreset = findPreset(state.presets, SIT_PRESET_ID, "坐下");
    this.standPreset = findPreset(state.presets, STAND_PRESET_ID, "站立");

    const activePreset = this.resolveActivePreset(state);

    this.setData({
      connected: !!state.connectedDeviceId,
      currentHeight: formatHeight(state.currentHeight, state.unit),
      currentSpeed: formatSpeed(state.lastKnownSpeed),
      unit: state.unit,
      sitPresetHeight: this.sitPreset ? formatHeight(this.sitPreset.height, state.unit) : "--",
      standPresetHeight: this.standPreset ? formatHeight(this.standPreset.height, state.unit) : "--",
      pendingCommand: state.pendingCommand,
      isAutoMoving: state.targetHeight !== null,
      activePreset
    });
  },

  resolveActivePreset(state: AppState): ActivePreset {
    if (state.targetHeight === null) {
      return "";
    }

    if (this.sitPreset && Math.abs(state.targetHeight - this.sitPreset.height) <= DEFAULT_TOLERANCE) {
      return "sit";
    }

    if (this.standPreset && Math.abs(state.targetHeight - this.standPreset.height) <= DEFAULT_TOLERANCE) {
      return "stand";
    }

    return "";
  },

  navigateToConnection() {
    wx.reLaunch({ url: "/pages/connection/index" });
  },

  navigateToSettings() {
    wx.navigateTo({ url: "/pages/settings/index" });
  },

  async onControlTouchStart(event: WechatMiniprogram.TouchEvent) {
    const command = event.currentTarget.dataset.command as MovementCommand | undefined;
    if (!command || command === "stop" || !this.data.connected) {
      return;
    }

    if (this.holdCommand === command) {
      return;
    }

    this.holdCommand = command;
    try {
      await deskService.sendCommand(command);
    } catch (error) {
      this.holdCommand = null;
      console.error("Failed to send manual command", error);
      wx.showToast({ title: "指令失败", icon: "none" });
    }
  },

  async onControlTouchEnd() {
    if (!this.holdCommand) {
      return;
    }

    this.holdCommand = null;

    try {
      await deskService.sendCommand("stop");
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
    try {
      await deskService.sendCommand("stop");
    } catch (error) {
      console.error("Failed to stop", error);
      wx.showToast({ title: "停止失败", icon: "none" });
    }
  },

  async onPresetTap(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.connected) {
      wx.showToast({ title: "请先连接桌子", icon: "none" });
      return;
    }

    const target = event.currentTarget.dataset.target as ActivePreset | undefined;
    const preset = target === "sit" ? this.sitPreset : this.standPreset;

    if (!target || !preset) {
      wx.showToast({ title: "预设未配置", icon: "none" });
      return;
    }

    try {
      await deskService.moveToHeight(preset.height);
      wx.showToast({ title: target === "sit" ? "坐下" : "站立", icon: "none" });
    } catch (error) {
      console.error("Failed to move to preset", error);
      wx.showToast({ title: "移动失败", icon: "none" });
    }
  },

  async onPresetStop(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.connected) {
      return;
    }

    const target = event.currentTarget.dataset.target as ActivePreset | undefined;

    try {
      await deskService.cancelTarget();
      await deskService.sendCommand("stop");
      if (target) {
        wx.showToast({ title: `${target === "sit" ? "坐下" : "站立"}已停止`, icon: "none" });
      } else {
        wx.showToast({ title: "已停止", icon: "none" });
      }
    } catch (error) {
      console.error("Failed to stop preset movement", error);
      wx.showToast({ title: "停止失败", icon: "none" });
    }
  }
});
