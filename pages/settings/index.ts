import { bindPageTheme } from "../../utils/page-theme";
import { getAppStore } from "../../utils/app-context";
import { convertHeight, formatHeight } from "../../utils/format";
import { saveAutoReconnect, savePresets, saveUnit } from "../../utils/storage";
import {
  getDeskDisplayName,
  SIT_PRESET_ID,
  STAND_PRESET_ID,
} from "../../utils/store";
import type { AppState, Preset } from "../../utils/store";
import { recordPresetSaved, recordUnitSwitch } from "../../utils/analytics";

const store = getAppStore();

type PresetTarget = "sit" | "stand";

type PageData = {
  unit: "cm" | "inch";
  autoReconnect: boolean;
  connectedDeviceId: string | null;
  activeDeskName: string;
  currentHeightDisplay: string;
  pendingCommand: string;
  sitHeightInput: string;
  standHeightInput: string;
  sitDirty: boolean;
  standDirty: boolean;
  sitSaved: boolean;
  standSaved: boolean;
  sitError: string;
  standError: string;
  canUseCurrentHeight: boolean;
  controlColor: string;
};

const findPresetById = (presets: Preset[], id: string): Preset | undefined =>
  presets.find((preset) => preset.id === id);

Page({
  data: {
    unit: "cm",
    autoReconnect: true,
    connectedDeviceId: null,
    activeDeskName: "",
    currentHeightDisplay: "--",
    pendingCommand: "stop",
    sitHeightInput: "",
    standHeightInput: "",
    sitDirty: false,
    standDirty: false,
    sitSaved: false,
    standSaved: false,
    sitError: "",
    standError: "",
    canUseCurrentHeight: false,
    controlColor: "#22241f",
  } as PageData,

  unsubscribe: null as null | (() => void),
  sitPreset: null as Preset | null,
  standPreset: null as Preset | null,

  unbindTheme: null as null | (() => void),

  onLoad() {
    this.unbindTheme = bindPageTheme((theme) => this.updateTheme(theme));
    this.unsubscribe = store.subscribe((state) => this.applyState(state));
    this.applyState(store.getState());
  },

  updateTheme(theme: string) {
    this.setData({ controlColor: theme === "dark" ? "#727a66" : "#22241f" });
  },

  onUnload() {
    this.unbindTheme?.();
    this.unbindTheme = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  },

  applyState(state: AppState) {
    this.sitPreset = findPresetById(state.presets, SIT_PRESET_ID) ?? null;
    this.standPreset = findPresetById(state.presets, STAND_PRESET_ID) ?? null;

    // Device notifications must not replace an unfinished edit.
    const sitHeightInput = this.data.sitDirty
      ? this.convertDraft(this.data.sitHeightInput, state.unit)
      : this.formatPresetInput(this.sitPreset, state.unit);
    const standHeightInput = this.data.standDirty
      ? this.convertDraft(this.data.standHeightInput, state.unit)
      : this.formatPresetInput(this.standPreset, state.unit);
    const connectedDesk = state.rememberedDesks.find(
      (desk) => desk.deviceId === state.connectedDeviceId,
    );

    this.setData({
      unit: state.unit,
      autoReconnect: state.autoReconnect,
      connectedDeviceId: state.connectedDeviceId,
      canUseCurrentHeight:
        !!state.connectedDeviceId &&
        !state.isConnecting &&
        state.currentHeight !== null,
      activeDeskName: connectedDesk ? getDeskDisplayName(connectedDesk) : "",
      currentHeightDisplay: formatHeight(state.currentHeight, state.unit),
      pendingCommand: state.pendingCommand,
      sitHeightInput,
      standHeightInput,
    });
  },

  convertDraft(value: string, nextUnit: "cm" | "inch"): string {
    if (
      this.data.unit === nextUnit ||
      !value.trim() ||
      !Number.isFinite(Number(value))
    ) {
      return value;
    }
    return convertHeight(Number(value), this.data.unit, nextUnit).toFixed(1);
  },

  formatPresetInput(preset: Preset | null, unit: "cm" | "inch"): string {
    if (!preset) {
      return "";
    }

    const value =
      unit === "cm"
        ? preset.height
        : convertHeight(preset.height, "cm", "inch");
    return value.toFixed(1);
  },

  onUnitChange(event: WechatMiniprogram.RadioGroupChange) {
    const unit = event.detail.value as "cm" | "inch";
    const fromUnit = this.data.unit;
    store.setState({ unit });
    saveUnit(unit);
    if (fromUnit !== unit) {
      recordUnitSwitch(fromUnit, unit);
    }
    wx.showToast({ title: `单位已切换为 ${unit}`, icon: "none" });
  },

  onAutoReconnectChange(event: WechatMiniprogram.SwitchChange) {
    const value = event.detail.value;
    store.setState({ autoReconnect: value });
    saveAutoReconnect(value);
    wx.showToast({
      title: value ? "已开启自动重连" : "已关闭自动重连",
      icon: "none",
    });
  },

  onPresetInput(event: WechatMiniprogram.Input) {
    const target = event.currentTarget.dataset.target as
      PresetTarget | undefined;
    if (!target) {
      return;
    }

    const key = target === "sit" ? "sitHeightInput" : "standHeightInput";
    this.setData({
      [key]: event.detail.value,
      [`${target}Dirty`]: true,
      [`${target}Saved`]: false,
      [`${target}Error`]: "",
    });
  },

  onUseCurrentHeight(event: WechatMiniprogram.TouchEvent) {
    const target = event.currentTarget.dataset.target as
      PresetTarget | undefined;
    if (!target) {
      return;
    }

    const currentHeight = store.getState().currentHeight;
    if (!this.data.canUseCurrentHeight || currentHeight === null) {
      wx.showToast({ title: "当前高度未知", icon: "none" });
      return;
    }

    const unit = this.data.unit;
    const displayValue =
      unit === "cm"
        ? currentHeight
        : convertHeight(currentHeight, "cm", "inch");
    const key = target === "sit" ? "sitHeightInput" : "standHeightInput";
    this.setData({
      [key]: displayValue.toFixed(1),
      [`${target}Dirty`]: true,
      [`${target}Saved`]: false,
      [`${target}Error`]: "",
    });
  },

  async onSavePreset(event: WechatMiniprogram.TouchEvent) {
    const target = event.currentTarget.dataset.target as
      PresetTarget | undefined;
    if (!target) {
      return;
    }

    const key = target === "sit" ? "sitHeightInput" : "standHeightInput";
    const inputValue = Number(this.data[key]);

    if (
      !this.data[key].trim() ||
      !Number.isFinite(inputValue) ||
      inputValue <= 0
    ) {
      this.setData({
        [`${target}Error`]: "请输入大于 0 的有效高度。",
        [`${target}Saved`]: false,
      });
      return;
    }

    const heightInCm =
      this.data.unit === "cm"
        ? inputValue
        : convertHeight(inputValue, "inch", "cm");
    try {
      await this.updatePresetHeight(target, heightInCm);
      this.setData({
        [`${target}Dirty`]: false,
        [`${target}Saved`]: true,
        [`${target}Error`]: "",
      });
      this.applyState(store.getState());
      recordPresetSaved(target, heightInCm);
      wx.showToast({ title: "已保存", icon: "none" });
    } catch (error) {
      this.setData({
        [`${target}Error`]: "保存失败，请重试。",
        [`${target}Saved`]: false,
      });
    }
  },

  async updatePresetHeight(target: PresetTarget, height: number) {
    const state = store.getState();
    const updatedPresets = [...state.presets];

    const id = target === "sit" ? SIT_PRESET_ID : STAND_PRESET_ID;
    const name = target === "sit" ? "坐下" : "站立";
    const index = updatedPresets.findIndex((preset) => preset.id === id);
    const roundedHeight = parseFloat(height.toFixed(1));

    const nextPreset: Preset = { id, name, height: roundedHeight };

    if (index >= 0) {
      updatedPresets[index] = nextPreset;
    } else {
      updatedPresets.push(nextPreset);
    }

    savePresets(updatedPresets);
    store.setState({ presets: updatedPresets });
  },
});
