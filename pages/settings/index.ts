import { getAppStore } from "../../utils/app-context";
import { convertHeight, formatHeight } from "../../utils/format";
import { saveAutoReconnect, savePresets, saveUnit } from "../../utils/storage";
import { SIT_PRESET_ID, STAND_PRESET_ID } from "../../utils/store";
import type { AppState, Preset } from "../../utils/store";

const store = getAppStore();

type PresetTarget = "sit" | "stand";

type PageData = {
  unit: "cm" | "inch";
  autoReconnect: boolean;
  connectedDeviceId: string | null;
  currentHeightDisplay: string;
  pendingCommand: string;
  sitHeightInput: string;
  standHeightInput: string;
};

const findPresetById = (presets: Preset[], id: string): Preset | undefined =>
  presets.find((preset) => preset.id === id);

Page({
  data: {
    unit: "cm",
    autoReconnect: true,
    connectedDeviceId: null,
    currentHeightDisplay: "--",
    pendingCommand: "stop",
    sitHeightInput: "",
    standHeightInput: ""
  } as PageData,

  unsubscribe: null as null | (() => void),
  sitPreset: null as Preset | null,
  standPreset: null as Preset | null,

  onLoad() {
    this.unsubscribe = store.subscribe((state) => this.applyState(state));
    this.applyState(store.getState());
  },

  onUnload() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  },

  applyState(state: AppState) {
    this.sitPreset = findPresetById(state.presets, SIT_PRESET_ID) ?? null;
    this.standPreset = findPresetById(state.presets, STAND_PRESET_ID) ?? null;

    const sitHeightInput = this.formatPresetInput(this.sitPreset, state.unit);
    const standHeightInput = this.formatPresetInput(this.standPreset, state.unit);

    this.setData({
      unit: state.unit,
      autoReconnect: state.autoReconnect,
      connectedDeviceId: state.connectedDeviceId,
      currentHeightDisplay: formatHeight(state.currentHeight, state.unit),
      pendingCommand: state.pendingCommand,
      sitHeightInput,
      standHeightInput
    });
  },

  formatPresetInput(preset: Preset | null, unit: "cm" | "inch"): string {
    if (!preset) {
      return "";
    }

    const value = unit === "cm" ? preset.height : convertHeight(preset.height, "cm", "inch");
    return value.toFixed(1);
  },

  onUnitChange(event: WechatMiniprogram.RadioGroupChange) {
    const unit = event.detail.value as "cm" | "inch";
    store.setState({ unit });
    saveUnit(unit);
    wx.showToast({ title: `单位已切换为 ${unit}`, icon: "none" });
  },

  onAutoReconnectChange(event: WechatMiniprogram.SwitchChange) {
    const value = event.detail.value;
    store.setState({ autoReconnect: value });
    saveAutoReconnect(value);
    wx.showToast({ title: value ? "已开启自动重连" : "已关闭自动重连", icon: "none" });
  },

  onPresetInput(event: WechatMiniprogram.Input) {
    const target = event.currentTarget.dataset.target as PresetTarget | undefined;
    if (!target) {
      return;
    }

    const key = target === "sit" ? "sitHeightInput" : "standHeightInput";
    this.setData({ [key]: event.detail.value });
  },

  onUseCurrentHeight(event: WechatMiniprogram.TouchEvent) {
    const target = event.currentTarget.dataset.target as PresetTarget | undefined;
    if (!target) {
      return;
    }

    const currentHeight = store.getState().currentHeight;
    if (currentHeight === null) {
      wx.showToast({ title: "当前高度未知", icon: "none" });
      return;
    }

    const unit = this.data.unit;
    const displayValue = unit === "cm" ? currentHeight : convertHeight(currentHeight, "cm", "inch");
    const key = target === "sit" ? "sitHeightInput" : "standHeightInput";
    this.setData({ [key]: displayValue.toFixed(1) });
  },

  async onSavePreset(event: WechatMiniprogram.TouchEvent) {
    const target = event.currentTarget.dataset.target as PresetTarget | undefined;
    if (!target) {
      return;
    }

    const key = target === "sit" ? "sitHeightInput" : "standHeightInput";
    const inputValue = parseFloat(this.data[key]);

    if (!Number.isFinite(inputValue)) {
      wx.showToast({ title: "请输入正确的高度", icon: "none" });
      return;
    }

    const heightInCm = this.data.unit === "cm" ? inputValue : convertHeight(inputValue, "inch", "cm");
    await this.updatePresetHeight(target, heightInCm);
    wx.showToast({ title: "已保存", icon: "none" });
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

    store.setState({ presets: updatedPresets });
    savePresets(updatedPresets);
  }
});
