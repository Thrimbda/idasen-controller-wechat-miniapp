import {
  CONTROL_CHARACTERISTIC_UUID,
  CONTROL_SERVICE_UUID,
  MovementCommand,
  POSITION_CHARACTERISTIC_UUID,
  POSITION_SERVICE_UUID,
  decodePositionSnapshot,
  encodeCommand
} from "./desk-protocol";

type Listener<T> = (payload: T) => void;

export interface AdapterState {
  available: boolean;
  discovering: boolean;
}

export interface DeviceFoundPayload {
  device: WechatMiniprogram.BlueToothDevice;
}

export interface ConnectionStatePayload {
  deviceId: string;
  connected: boolean;
  ready?: boolean;
}

export interface PositionPayload {
  deviceId: string;
  height: number;
  speed: number;
  rawHeight: number;
  rawSpeed: number;
}

export interface ErrorPayload {
  message: string;
  error?: unknown;
}

export type DeskBleEventMap = {
  adapterState: AdapterState;
  deviceFound: DeviceFoundPayload;
  connectionState: ConnectionStatePayload;
  position: PositionPayload;
  error: ErrorPayload;
};

const promisify = <TResult = WechatMiniprogram.GeneralCallbackResult>(
  fn: (options: any) => void,
  options: Record<string, unknown> = {}
): Promise<TResult> =>
  new Promise((resolve, reject) => {
    fn({
      ...options,
      success: (res: TResult) => resolve(res),
      fail: (err: WechatMiniprogram.GeneralCallbackResult) => reject(err)
    });
  });

const ensureWx = () => {
  if (typeof wx === "undefined") {
    throw new Error("wx API is unavailable in the current environment");
  }
};

const isAlreadyOpenedError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const errMsg = (error as { errMsg?: unknown }).errMsg;
  return typeof errMsg === "string" && errMsg.includes("already opened");
};

const isAlreadyDiscoveringError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const errMsg = (error as { errMsg?: unknown }).errMsg;
  return typeof errMsg === "string" && errMsg.includes("already discovering");
};

const normalizeUuid = (uuid: string): string => uuid.replace(/[{}-]/g, "").toLowerCase();

export class DeskBleClient {
  private listeners: { [K in keyof DeskBleEventMap]: Set<Listener<DeskBleEventMap[K]>> } = {
    adapterState: new Set(),
    deviceFound: new Set(),
    connectionState: new Set(),
    position: new Set(),
    error: new Set()
  };

  private currentDeviceId: string | null = null;
  private hasSubscribedPosition = false;
  private discoveryStarted = false;
  private positionServiceId: string | null = null;
  private positionCharacteristicId: string | null = null;
  private controlServiceId: string | null = null;
  private controlCharacteristicId: string | null = null;

  constructor(private nameMatcher: (name: string) => boolean = (name) => name.includes("Desk")) {
    if (typeof wx !== "undefined") {
      wx.onBluetoothAdapterStateChange((state) => {
        this.emit("adapterState", {
          available: !!state.available,
          discovering: !!state.discovering
        });
      });

      wx.onBluetoothDeviceFound((result) => {
        result.devices.forEach((device) => {
          const resolvedName = device.name ?? device.localName ?? "";
          console.info("[BLE] 发现原始设备", resolvedName, {
            RSSI: device.RSSI,
            advertisServiceUUIDs: device.advertisServiceUUIDs
          });

          if (!resolvedName) {
            console.debug("[BLE] 忽略无名称设备");
            return;
          }

          if (!this.nameMatcher(resolvedName)) {
            console.debug("[BLE] 忽略设备", resolvedName);
            return;
          }

          console.info("[BLE] 匹配设备", resolvedName);
          this.emit("deviceFound", { device });
        });
      });

      wx.onBLEConnectionStateChange((res) => {
        if (res.deviceId !== this.currentDeviceId) {
          return;
        }

        if (res.connected) {
          console.info("[BLE] Transport connected");
          return;
        }

        this.releaseConnection(res.deviceId);
      });

      wx.onBLECharacteristicValueChange((res) => {
        if (
          res.deviceId === this.currentDeviceId &&
          res.serviceId === POSITION_SERVICE_UUID &&
          res.characteristicId === POSITION_CHARACTERISTIC_UUID &&
          res.value
        ) {
          try {
            const snapshot = decodePositionSnapshot(res.value);
            this.emit("position", { ...snapshot, deviceId: res.deviceId });
          } catch (error) {
            this.emit("error", {
              message: "Failed to decode position payload",
              error
            });
          }
        }
      });
    }
  }

  on<K extends keyof DeskBleEventMap>(event: K, listener: Listener<DeskBleEventMap[K]>): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  private emit<K extends keyof DeskBleEventMap>(event: K, payload: DeskBleEventMap[K]) {
    this.listeners[event].forEach((listener) => listener(payload));
  }

  async ensureAdapterOpen(): Promise<void> {
    ensureWx();
    try {
      await promisify(wx.openBluetoothAdapter as unknown as (options: any) => void);
    } catch (error) {
      if (isAlreadyOpenedError(error)) {
        return;
      }
      this.emit("error", { message: "无法打开蓝牙适配器", error });
      throw error;
    }
  }

  async startScan(): Promise<void> {
    ensureWx();
    if (!this.discoveryStarted) {
      await this.ensureAdapterOpen();
      try {
        await promisify(wx.startBluetoothDevicesDiscovery as unknown as (options: any) => void, {
          allowDuplicatesKey: true
        });
        this.discoveryStarted = true;
      } catch (error) {
        if (isAlreadyDiscoveringError(error)) {
          console.debug("[BLE] 蓝牙扫描已在进行中");
          this.discoveryStarted = true;
          return;
        }
        this.emit("error", { message: "启动扫描失败", error });
        throw error;
      }
    }
  }

  async stopScan(): Promise<void> {
    ensureWx();
    if (this.discoveryStarted) {
      await promisify(wx.stopBluetoothDevicesDiscovery as unknown as (options: any) => void);
      this.discoveryStarted = false;
    }
  }

  async connect(deviceId: string): Promise<void> {
    ensureWx();
    if (this.currentDeviceId) {
      throw new Error("A BLE connection is still active");
    }

    await this.stopScan();

    try {
      this.resetConnectionState();
      await promisify(wx.createBLEConnection as unknown as (options: any) => void, { deviceId });
      this.currentDeviceId = deviceId;
      await this.discoverServices(deviceId);

      if (this.currentDeviceId !== deviceId) {
        throw new Error("BLE connection closed before service discovery completed");
      }

      this.emit("connectionState", { deviceId, connected: true, ready: true });
    } catch (error) {
      try {
        await this.closeFailedCandidate(deviceId);
      } catch (cleanupError) {
        this.emit("error", {
          message: "连接设备失败，且无法关闭候选连接",
          error: cleanupError
        });
        throw cleanupError;
      }

      this.emit("error", { message: "连接设备失败", error });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    ensureWx();
    if (!this.currentDeviceId) {
      return;
    }

    const deviceId = this.currentDeviceId;
    try {
      await promisify(wx.closeBLEConnection as unknown as (options: any) => void, { deviceId });
    } catch (error) {
      this.emit("error", { message: "断开连接失败", error });
      throw error;
    }

    this.releaseConnection(deviceId);
  }

  async writeCommand(command: MovementCommand): Promise<void> {
    ensureWx();
    if (!this.currentDeviceId) {
      throw new Error("No device connected");
    }

    if (!this.controlServiceId || !this.controlCharacteristicId) {
      throw new Error("Control characteristic not discovered");
    }

    const buffer = encodeCommand(command);
    try {
      await promisify(wx.writeBLECharacteristicValue as unknown as (options: any) => void, {
        deviceId: this.currentDeviceId,
        serviceId: this.controlServiceId,
        characteristicId: this.controlCharacteristicId,
        value: buffer
      });
    } catch (error) {
      this.emit("error", { message: `写入指令失败: ${command}`, error });
      throw error;
    }
  }

  async subscribePosition(): Promise<void> {
    ensureWx();
    if (!this.currentDeviceId) {
      throw new Error("No device connected");
    }

    if (this.hasSubscribedPosition) {
      return;
    }

    if (!this.positionServiceId || !this.positionCharacteristicId) {
      throw new Error("Position characteristic not discovered");
    }

    try {
      await promisify(wx.notifyBLECharacteristicValueChange as unknown as (options: any) => void, {
        deviceId: this.currentDeviceId,
        serviceId: this.positionServiceId,
        characteristicId: this.positionCharacteristicId,
        state: true
      });
      this.hasSubscribedPosition = true;
      await this.readPosition();
    } catch (error) {
      this.emit("error", { message: "订阅高度通知失败", error });
      throw error;
    }
  }

  async readPosition(): Promise<void> {
    ensureWx();
    if (!this.currentDeviceId) {
      throw new Error("No device connected");
    }
    if (!this.positionServiceId || !this.positionCharacteristicId) {
      throw new Error("Position characteristic not discovered");
    }

    try {
      await promisify(wx.readBLECharacteristicValue as unknown as (options: any) => void, {
        deviceId: this.currentDeviceId,
        serviceId: this.positionServiceId,
        characteristicId: this.positionCharacteristicId
      });
    } catch (error) {
      this.emit("error", { message: "读取高度失败", error });
      throw error;
    }
  }

  private resetConnectionState() {
    this.currentDeviceId = null;
    this.hasSubscribedPosition = false;
    this.positionServiceId = null;
    this.positionCharacteristicId = null;
    this.controlServiceId = null;
    this.controlCharacteristicId = null;
  }

  private releaseConnection(deviceId: string) {
    if (this.currentDeviceId !== deviceId) {
      return;
    }
    this.resetConnectionState();
    this.emit("connectionState", { deviceId, connected: false });
  }

  private async closeFailedCandidate(deviceId: string): Promise<void> {
    if (this.currentDeviceId !== deviceId) {
      return;
    }

    await promisify(wx.closeBLEConnection as unknown as (options: any) => void, { deviceId });
    this.releaseConnection(deviceId);
  }

  private async discoverServices(deviceId: string): Promise<void> {
    const services = await promisify<WechatMiniprogram.GetBLEDeviceServicesSuccessCallbackResult>(
      wx.getBLEDeviceServices as unknown as (options: any) => void,
      { deviceId }
    );

    const positionCharacteristicKey = normalizeUuid(POSITION_CHARACTERISTIC_UUID);
    const controlCharacteristicKey = normalizeUuid(CONTROL_CHARACTERISTIC_UUID);

    console.info("[BLE] 已发现服务", services.services.map((service) => service.uuid));
    for (const service of services.services) {
      if (!service.uuid) {
        continue;
      }

      const characteristics =
        await promisify<WechatMiniprogram.GetBLEDeviceCharacteristicsSuccessCallbackResult>(
          wx.getBLEDeviceCharacteristics as unknown as (options: any) => void,
          {
            deviceId,
            serviceId: service.uuid
          }
        );

      console.info(
        "[BLE] 服务特征",
        service.uuid,
        characteristics.characteristics.map((item) => ({
          uuid: item.uuid,
          properties: item.properties
        }))
      );

      for (const characteristic of characteristics.characteristics) {
        const normalizedCharacteristic = normalizeUuid(characteristic.uuid);
        if (normalizedCharacteristic === positionCharacteristicKey) {
          if (!this.positionServiceId) {
            this.positionServiceId = service.uuid;
            console.info("[BLE] 绑定位置服务", this.positionServiceId);
          }
          this.positionCharacteristicId = characteristic.uuid;
          console.info("[BLE] 发现位置特征", this.positionCharacteristicId);
        }
        if (normalizedCharacteristic === controlCharacteristicKey) {
          if (!this.controlServiceId) {
            this.controlServiceId = service.uuid;
            console.info("[BLE] 绑定控制服务", this.controlServiceId);
          }
          this.controlCharacteristicId = characteristic.uuid;
          console.info("[BLE] 发现控制特征", this.controlCharacteristicId);
        }
      }

      if (this.positionCharacteristicId && this.controlCharacteristicId) {
        break;
      }
    }

    if (!this.positionServiceId || !this.positionCharacteristicId) {
      throw new Error(
        `桌子设备未暴露位置特征, services=${JSON.stringify(
          services.services.map((service) => service.uuid)
        )}`
      );
    }

    if (!this.controlServiceId || !this.controlCharacteristicId) {
      console.warn("未找到控制特征，可能无法发送移动指令");
    }
  }
}
