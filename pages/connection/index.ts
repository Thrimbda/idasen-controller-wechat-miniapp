import { getAppStore } from "../../utils/app-context";
import { getDeskService } from "../../utils/desk-service";
import { loadLastDeviceId } from "../../utils/storage";
import type { AppState } from "../../utils/store";

const store = getAppStore();
const deskService = getDeskService();

type DeviceView = { deviceId: string; name: string; RSSI: number };

type PageData = {
  isScanning: boolean;
  isConnecting: boolean;
  connectedDeviceId: string | null;
  devices: DeviceView[];
  lastDeviceId: string | null;
};

Page({
  data: {
    isScanning: false,
    isConnecting: false,
    connectedDeviceId: null,
    devices: [],
    lastDeviceId: null
  } as PageData,

  unsubscribe: null as null | (() => void),

  onLoad() {
    this.unsubscribe = store.subscribe((state) => this.applyState(state));
    this.applyState(store.getState());

    const lastDeviceId = loadLastDeviceId();
    if (lastDeviceId) {
      this.setData({ lastDeviceId });
    }

    if (store.getState().connectedDeviceId) {
      wx.reLaunch({ url: "/pages/control/index" });
      return;
    }

    if (!store.getState().isScanning) {
      void deskService.startScan().catch((error) => {
        this.handleError("扫描失败", error);
      });
    }
  },

  onUnload() {
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (store.getState().isScanning) {
      void deskService.stopScan().catch((error) => {
        console.warn("停止扫描失败", error);
      });
    }
  },

  applyState(state: AppState) {
    this.setData({
      isScanning: state.isScanning,
      isConnecting: state.isConnecting,
      connectedDeviceId: state.connectedDeviceId,
      devices: state.availableDevices.map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        RSSI: device.RSSI
      }))
    });

    if (state.connectedDeviceId) {
      wx.reLaunch({ url: "/pages/control/index" });
    }
  },

  async onScanTap() {
    try {
      await deskService.startScan();
      wx.showToast({ title: "开始扫描", icon: "none" });
    } catch (error) {
      this.handleError("扫描失败", error);
    }
  },

  async onStopScanTap() {
    try {
      await deskService.stopScan();
      wx.showToast({ title: "已停止扫描", icon: "none" });
    } catch (error) {
      this.handleError("停止扫描失败", error);
    }
  },

  async onConnect(event: WechatMiniprogram.TouchEvent) {
    const deviceId = event.currentTarget.dataset.deviceId as string | undefined;
    if (!deviceId) {
      return;
    }

    try {
      await deskService.connect(deviceId);
      wx.showToast({ title: "连接中...", icon: "loading", duration: 800 });
      setTimeout(() => {
        if (store.getState().connectedDeviceId) {
          wx.reLaunch({ url: "/pages/control/index" });
        }
      }, 500);
    } catch (error) {
      this.handleError("连接失败", error);
    }
  },

  async onDisconnect() {
    try {
      await deskService.disconnect();
      wx.showToast({ title: "已断开", icon: "none" });
    } catch (error) {
      this.handleError("断开失败", error);
    }
  },

  handleError(message: string, error: unknown) {
    console.error(message, error);
    wx.showToast({ title: message, icon: "none" });
  }
});
