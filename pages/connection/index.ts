import { bindPageTheme } from "../../utils/page-theme";
import { getAppStore } from "../../utils/app-context";
import { getDeskService } from "../../utils/desk-service";
import { getDeskDisplayName } from "../../utils/store";
import type { AppState } from "../../utils/store";
import { recordConnectFail } from "../../utils/analytics";

const store = getAppStore();
const deskService = getDeskService();

type DeviceView = {
  deviceId: string;
  name: string;
  RSSI: number;
  isConnecting: boolean;
};

type RememberedDeskView = {
  deviceId: string;
  name: string;
  isCurrent: boolean;
  isConnecting: boolean;
  isActive: boolean;
};

type PageData = {
  isScanning: boolean;
  hasScanned: boolean;
  errorMessage: string;
  isConnecting: boolean;
  connectedDeviceId: string | null;
  rememberedDesks: RememberedDeskView[];
  hasRememberedDesks: boolean;
  devices: DeviceView[];
  deviceCount: number;
  rememberedDeskCount: number;
  replacementDeskName: string;
};

Page({
  data: {
    isScanning: false,
    hasScanned: false,
    errorMessage: "",
    isConnecting: false,
    connectedDeviceId: null,
    rememberedDesks: [],
    hasRememberedDesks: false,
    devices: [],
    deviceCount: 0,
    rememberedDeskCount: 0,
    replacementDeskName: "",
  } as PageData,

  unsubscribe: null as null | (() => void),
  unbindTheme: null as null | (() => void),
  replacementDeskId: null as string | null,

  manageMode: false,

  onLoad(options: Record<string, string | undefined>) {
    this.unbindTheme = bindPageTheme();
    this.manageMode = options.manage === "1";
    this.unsubscribe = store.subscribe((state) => this.applyState(state));
    this.applyState(store.getState());

    const state = store.getState();
    if (state.connectedDeviceId && !state.isConnecting && !this.manageMode) {
      wx.reLaunch({ url: "/pages/control/index" });
      return;
    }

    if (!state.rememberedDesks.length && !state.isScanning) {
      void this.startScan();
    }
  },

  onUnload() {
    this.unbindTheme?.();
    this.unbindTheme = null;
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (store.getState().isScanning) {
      void deskService.stopScan().catch((error) => {
        console.warn("停止扫描失败", error);
      });
    }
  },

  applyState(state: AppState) {
    const rememberedDesks = state.rememberedDesks.map((desk) => ({
      deviceId: desk.deviceId,
      name: getDeskDisplayName(desk),
      isCurrent: state.connectedDeviceId === desk.deviceId,
      isConnecting: state.pendingDeskId === desk.deviceId,
      isActive: state.activeDeskId === desk.deviceId,
    }));
    const replacementDesk = this.replacementDeskId
      ? rememberedDesks.find((desk) => desk.deviceId === this.replacementDeskId)
      : undefined;
    const devices = state.availableDevices.map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      RSSI: device.RSSI,
      isConnecting: state.pendingDeskId === device.deviceId,
    }));

    this.setData({
      isScanning: state.isScanning,
      hasScanned: this.data.hasScanned || state.isScanning,
      isConnecting: state.isConnecting,
      connectedDeviceId: state.connectedDeviceId,
      rememberedDesks,
      hasRememberedDesks: rememberedDesks.length > 0,
      devices,
      deviceCount: devices.length,
      rememberedDeskCount: rememberedDesks.length,
      replacementDeskName: replacementDesk?.name ?? "",
    });

    if (state.connectedDeviceId && !state.isConnecting && !this.manageMode) {
      wx.reLaunch({ url: "/pages/control/index" });
    }
  },

  async startScan() {
    this.setData({ errorMessage: "", hasScanned: true });
    try {
      await deskService.startScan();
      wx.showToast({ title: "开始扫描", icon: "none" });
    } catch (error) {
      this.handleError("扫描失败", error);
      recordConnectFail({ step: "scan", error });
    }
  },

  navigateToControl() {
    wx.reLaunch({ url: "/pages/control/index" });
  },

  onScanAction() {
    if (this.data.isScanning) {
      void this.onStopScanTap();
    } else {
      this.onScanTap();
    }
  },

  onScanTap() {
    this.applyState(store.getState());
    void this.startScan();
  },

  async onStopScanTap() {
    try {
      await deskService.stopScan();
      wx.showToast({ title: "已停止扫描", icon: "none" });
    } catch (error) {
      this.handleError("停止扫描失败", error);
    }
  },

  onRememberedConnect(event: WechatMiniprogram.TouchEvent) {
    const deviceId = event.currentTarget.dataset.deviceId as string | undefined;
    if (deviceId) {
      void this.connectDevice(deviceId, true);
    }
  },

  onConnect(event: WechatMiniprogram.TouchEvent) {
    const deviceId = event.currentTarget.dataset.deviceId as string | undefined;
    if (deviceId) {
      void this.connectDevice(deviceId, false);
    }
  },

  async connectDevice(deviceId: string, isRememberedDesk: boolean) {
    this.setData({ errorMessage: "" });
    try {
      await deskService.selectDesk(deviceId, {
        ...(this.replacementDeskId
          ? { replaceDeskId: this.replacementDeskId }
          : {}),
      });
      this.replacementDeskId = null;
      wx.showToast({ title: "已连接", icon: "success" });
    } catch (error) {
      if (isRememberedDesk) {
        this.offerReplacement(deviceId);
        return;
      }
      this.handleError("连接失败", error);
    }
  },

  offerReplacement(deviceId: string) {
    const desk = this.data.rememberedDesks.find(
      (item) => item.deviceId === deviceId,
    );
    if (!desk) {
      this.handleError("连接失败", new Error("未找到已记住的桌子"));
      return;
    }

    wx.showModal({
      title: "找不到这张桌子",
      content: `要重新搜索并更新“${desk.name}”吗？名称会保留。`,
      cancelText: "保留记录",
      confirmText: "重新搜索",
      success: (result) => {
        if (!result.confirm) {
          return;
        }
        this.replacementDeskId = deviceId;
        this.applyState(store.getState());
        void this.startScan();
      },
    });
  },

  onRenameDesk(event: WechatMiniprogram.TouchEvent) {
    const deviceId = event.currentTarget.dataset.deviceId as string | undefined;
    const desk = this.data.rememberedDesks.find(
      (item) => item.deviceId === deviceId,
    );
    if (!deviceId || !desk) {
      return;
    }

    wx.showModal({
      title: "给桌子命名",
      content: desk.name,
      editable: true,
      placeholderText: "例如：书房桌",
      confirmText: "保存",
      success: (result) => {
        if (!result.confirm) {
          return;
        }
        const nickname = (result as { content?: string }).content?.trim() ?? "";
        void deskService
          .renameDesk(deviceId, nickname)
          .then(() => wx.showToast({ title: "名称已保存", icon: "none" }))
          .catch((error) => this.handleError("名称无效", error));
      },
    });
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
    this.setData({
      errorMessage:
        message === "名称无效"
          ? "名称未保存，请换一个名称再试。"
          : `${message}。请确认桌子已通电、手机蓝牙已开启，然后重试。`,
    });
    console.error(message, error);
    wx.showToast({ title: message, icon: "none" });
  },
});
