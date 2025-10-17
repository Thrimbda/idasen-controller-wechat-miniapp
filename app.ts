/// <reference path="./types/index.d.ts" />

import { createAppStore, CORE_PRESETS } from "./utils/store";
import type { Preset } from "./utils/store";
import { loadAutoReconnect, loadPresets, loadUnit, loadLastDeviceId } from "./utils/storage";
import { getDeskService } from "./utils/desk-service";
import { setAppStore } from "./utils/app-context";

const store = createAppStore();
setAppStore(store);

const ensureCorePresets = (source: Preset[]): Preset[] => {
  const merged = [...source];

  CORE_PRESETS.forEach((preset) => {
    if (!merged.some((item) => item.id === preset.id)) {
      merged.push({ ...preset });
    }
  });

  return merged;
};

type IAppOption = WechatMiniprogram.App.Option & {
  globalData: typeof store;
};

App<IAppOption>({
  globalData: store,

  onLaunch() {
    const presets = ensureCorePresets(loadPresets());
    const unit = loadUnit();
    const autoReconnect = loadAutoReconnect();

    store.setState({
      presets,
      unit: unit ?? store.getState().unit,
      autoReconnect: autoReconnect ?? store.getState().autoReconnect
    });

    getDeskService();

    if (typeof wx !== "undefined") {
      const lastDeviceId = loadLastDeviceId();
      if (!lastDeviceId) {
        setTimeout(() => {
          if (!store.getState().connectedDeviceId) {
            wx.reLaunch({ url: "/pages/connection/index" });
          }
        }, 0);
      }
    }
  },

  onShow() {},

  onHide() {},

  onPageNotFound() {},

  onUnhandledRejection() {},

  onThemeChange() {},

  onError(err) {
    console.error("App error:", err);
  }
});
