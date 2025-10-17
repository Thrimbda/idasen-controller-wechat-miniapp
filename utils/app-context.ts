import type { AppStore } from "./store";

declare const getApp: <T extends WechatMiniprogram.IAnyObject = WechatMiniprogram.IAnyObject>() => T;

interface AppWithStore extends WechatMiniprogram.IAnyObject {
  globalData: AppStore;
}

let appStore: AppStore | null = null;

export const setAppStore = (store: AppStore): void => {
  appStore = store;
};

export const getAppStore = (): AppStore => {
  if (appStore) {
    return appStore;
  }

  if (typeof getApp === "function") {
    const app = getApp<AppWithStore>();
    if (app && app.globalData) {
      appStore = app.globalData;
      return appStore;
    }
  }

  throw new Error("App store is not initialized");
};
