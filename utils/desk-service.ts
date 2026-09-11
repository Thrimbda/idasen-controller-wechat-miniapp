import { DEFAULT_TOLERANCE, MovementCommand } from "./desk-protocol";
import { DeskBleClient, type DeskBleEventMap, type PositionPayload } from "./ble";
import { getAppStore } from "./app-context";
import {
  loadLastDeviceId,
  loadRememberedDeskDirectory,
  saveConfirmedDeskDirectory,
  saveRememberedDesks
} from "./storage";
import {
  beginConnectAttempt,
  recordCommandTimeout,
  recordConnectFail,
  recordConnectSuccess,
  recordManualDisconnect,
  recordUnexpectedDisconnect
} from "./analytics";
import { DEFAULT_REMEMBERED_DESK_NAME } from "./store";
import type { AppStore, DiscoveredDevice, RememberedDesk } from "./store";

const MOVEMENT_TIMEOUT_MS = 3000;
const MOVEMENT_CHECK_INTERVAL_MS = 400;
const COMMAND_REISSUE_MIN_INTERVAL_MS = 450;
const COMMAND_REISSUE_MIN_DISTANCE_CM = 0.3;
const MOVEMENT_DIRECTION_OFFSET_CM = 0.4;
const SPEED_OFFSET_FACTOR = 0.2;
const MIN_DIRECTION_OFFSET_CM = 0.05;
const SPEED_STABLE_THRESHOLD_CM_S = 0.05;
const FINE_ADJUST_THRESHOLD_CM = 0.3;
const FINE_PULSE_DURATION_MS = 180;
const MANUAL_COMMAND_INTERVAL_MS = 200;

export interface DeskBlePort {
  on<K extends keyof DeskBleEventMap>(
    event: K,
    listener: (payload: DeskBleEventMap[K]) => void
  ): () => void;
  startScan(): Promise<void>;
  stopScan(): Promise<void>;
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  writeCommand(command: MovementCommand): Promise<void>;
  subscribePosition(): Promise<void>;
}

export interface DeskServiceOptions {
  store?: AppStore;
  ble?: DeskBlePort;
  autoReconnect?: boolean;
}

export interface SelectDeskOptions {
  autoReconnect?: boolean;
  replaceDeskId?: string;
}

export class DeskService {
  private readonly store: AppStore;
  private readonly ble: DeskBlePort;
  private movementTimer: ReturnType<typeof setTimeout> | null = null;
  private lastNotificationTs = 0;
  private targetHeight: number | null = null;
  private lastCommand: MovementCommand = "stop";
  private lastCommandAt = 0;
  private lastCommandHeight: number | null = null;
  private isAutoMoving = false;
  private manualCommand: MovementCommand | null = null;
  private manualCommandTimer: ReturnType<typeof setInterval> | null = null;
  private fineAdjustTimer: ReturnType<typeof setTimeout> | null = null;
  private autoReconnectAttempted = false;
  private disconnectRequested = false;
  private currentConnectAutoReconnect = false;
  private connectionOperation = 0;
  private expectedDeviceId: string | null = null;
  private pendingReplacementDeskId: string | null = null;
  private switchInProgress = false;
  private movementEpoch = 0;
  private manualCommandEpoch = 0;

  constructor(options: DeskServiceOptions = {}) {
    this.store = options.store ?? getAppStore();
    this.ble = options.ble ?? new DeskBleClient();
    this.hydrateRememberedDesks();
    this.bindBleEvents();
    if (options.autoReconnect !== false) {
      this.tryAutoReconnect();
    }
  }

  private hydrateRememberedDesks() {
    const directory = loadRememberedDeskDirectory();
    this.store.setState({
      rememberedDesks: directory.rememberedDesks,
      activeDeskId: directory.activeDeskId,
      pendingDeskId: null
    });
  }

  private bindBleEvents() {
    this.ble.on("adapterState", (state) => {
      this.store.setState({ isScanning: state.discovering });
    });

    this.ble.on("deviceFound", ({ device }) => {
      const devices = this.store.getState().availableDevices;
      const existingIndex = devices.findIndex((d) => d.deviceId === device.deviceId);
      const entry: DiscoveredDevice = {
        deviceId: device.deviceId,
        name: device.name || device.localName || "未知设备",
        RSSI: device.RSSI ?? 0,
        localName: device.localName
      };

      if (existingIndex >= 0) {
        const updated = [...devices];
        updated[existingIndex] = entry;
        this.store.setState({ availableDevices: updated });
      } else {
        this.store.setState({ availableDevices: [...devices, entry] });
      }
    });

    this.ble.on("connectionState", ({ deviceId, connected, ready }) => {
      if (connected) {
        if (!ready) {
          console.info("[DeskService] Ignoring transport-only connected state");
          return;
        }
        this.handleReadyConnection(deviceId);
        return;
      }

      this.handleDisconnected(deviceId);
    });

    this.ble.on("position", (payload) => {
      const state = this.store.getState();
      if (payload.deviceId !== state.connectedDeviceId || this.switchInProgress) {
        console.info("[DeskService] Ignoring stale position update", {
          switchInProgress: this.switchInProgress
        });
        return;
      }

      this.lastNotificationTs = Date.now();
      this.store.setState({
        currentHeight: payload.height,
        lastKnownSpeed: payload.speed
      });

      console.info("[DeskService] Position update", {
        height: payload.height,
        speed: payload.speed,
        targetHeight: this.targetHeight,
        lastCommand: this.lastCommand
      });

      if (this.isAutoMoving) {
        void this.evaluateMovement(payload, this.movementEpoch);
      }
    });

    this.ble.on("error", (error) => {
      console.error("BLE error", error);
    });
  }

  private handleReadyConnection(deviceId: string) {
    const state = this.store.getState();
    if (
      !state.isConnecting ||
      state.pendingDeskId !== deviceId ||
      this.expectedDeviceId !== deviceId
    ) {
      console.info("[DeskService] Ignoring stale ready connection");
      return;
    }

    const rememberedDesks = this.upsertRememberedDesk(deviceId, this.pendingReplacementDeskId);
    try {
      saveConfirmedDeskDirectory(rememberedDesks, deviceId);
    } catch (error) {
      console.warn("Failed to persist confirmed desk", error);
    }

    const deviceMeta = state.availableDevices.find((item) => item.deviceId === deviceId);
    this.store.setState({
      rememberedDesks,
      activeDeskId: deviceId,
      pendingDeskId: null,
      connectedDeviceId: deviceId,
      isConnecting: false
    });
    void this.subscribeToPosition(deviceId);
    recordConnectSuccess({
      deviceName: deviceMeta?.name,
      rssi: deviceMeta?.RSSI,
      autoReconnect: this.currentConnectAutoReconnect
    });
    this.disconnectRequested = false;
    this.currentConnectAutoReconnect = false;
    this.pendingReplacementDeskId = null;
    this.expectedDeviceId = null;
  }

  private handleDisconnected(deviceId: string) {
    const state = this.store.getState();
    if (state.connectedDeviceId !== deviceId) {
      return;
    }

    const isSwitchingAway =
      this.switchInProgress &&
      !!this.expectedDeviceId &&
      this.expectedDeviceId !== deviceId;

    this.store.setState({
      connectedDeviceId: null,
      isConnecting: isSwitchingAway,
      pendingDeskId: isSwitchingAway ? state.pendingDeskId : null,
      currentHeight: null,
      lastKnownSpeed: null
    });
    this.resetMovementState();
    if (this.disconnectRequested || isSwitchingAway) {
      recordManualDisconnect();
    } else {
      recordUnexpectedDisconnect("unknown");
    }

    this.disconnectRequested = false;
    if (!isSwitchingAway) {
      this.currentConnectAutoReconnect = false;
      this.expectedDeviceId = null;
      this.pendingReplacementDeskId = null;
    }
  }

  async startScan(): Promise<void> {
    if (this.store.getState().isConnecting) {
      throw new Error("正在切换桌子，暂时不能扫描");
    }
    this.store.setState({ isScanning: true, availableDevices: [] });
    try {
      await this.ble.startScan();
    } catch (error) {
      this.store.setState({ isScanning: false });
      throw error;
    }
  }

  async stopScan(): Promise<void> {
    await this.ble.stopScan();
    this.store.setState({ isScanning: false });
  }

  async connect(deviceId: string, options?: SelectDeskOptions): Promise<void> {
    await this.selectDesk(deviceId, options);
  }

  async selectDesk(deviceId: string, options: SelectDeskOptions = {}): Promise<void> {
    if (!deviceId) {
      throw new Error("缺少桌子设备 ID");
    }

    const initialState = this.store.getState();
    if (this.switchInProgress || initialState.isConnecting) {
      throw new Error("正在连接另一张桌子");
    }

    if (initialState.connectedDeviceId === deviceId) {
      return;
    }

    const operation = ++this.connectionOperation;
    const currentDeviceId = initialState.connectedDeviceId;
    const deviceMeta = initialState.availableDevices.find((item) => item.deviceId === deviceId);
    const autoReconnect = !!options.autoReconnect;

    this.switchInProgress = true;
    this.expectedDeviceId = deviceId;
    this.pendingReplacementDeskId = options.replaceDeskId ?? null;
    this.currentConnectAutoReconnect = autoReconnect;
    this.disconnectRequested = false;
    this.store.setState({
      isConnecting: true,
      pendingDeskId: deviceId
    });
    beginConnectAttempt({
      deviceName: deviceMeta?.name,
      rssi: deviceMeta?.RSSI,
      autoReconnect
    });

    try {
      if (currentDeviceId) {
        await this.stopForSwitch(currentDeviceId, operation);
        this.assertCurrentConnectionOperation(operation, deviceId);

        this.disconnectRequested = true;
        await this.ble.disconnect();
        if (this.store.getState().connectedDeviceId === currentDeviceId) {
          this.handleDisconnected(currentDeviceId);
        }
        this.assertCurrentConnectionOperation(operation, deviceId);
      }

      await this.ble.connect(deviceId);
      if (this.store.getState().connectedDeviceId !== deviceId) {
        throw new Error("桌子尚未完成服务发现");
      }
    } catch (error) {
      if (operation === this.connectionOperation) {
        this.store.setState({
          isConnecting: false,
          pendingDeskId: null
        });
        this.disconnectRequested = false;
        this.expectedDeviceId = null;
        this.pendingReplacementDeskId = null;
        this.currentConnectAutoReconnect = false;
      }
      recordConnectFail({
        step: "connect",
        error,
        deviceName: deviceMeta?.name,
        autoReconnect
      });
      throw error;
    } finally {
      if (operation === this.connectionOperation) {
        this.switchInProgress = false;
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.switchInProgress) {
      throw new Error("正在切换桌子");
    }

    this.connectionOperation += 1;
    this.expectedDeviceId = null;
    this.pendingReplacementDeskId = null;
    this.disconnectRequested = true;
    this.resetMovementState();
    this.store.setState({ isConnecting: false, pendingDeskId: null });
    try {
      await this.ble.disconnect();
    } catch (error) {
      this.disconnectRequested = false;
      throw error;
    }
    this.clearManualCommand();
  }

  async renameDesk(deviceId: string, nickname: string): Promise<void> {
    const normalizedNickname = nickname.trim();
    if (!normalizedNickname || normalizedNickname.length > 24) {
      throw new Error("桌子名称需为 1 到 24 个字符");
    }

    const state = this.store.getState();
    const index = state.rememberedDesks.findIndex((desk) => desk.deviceId === deviceId);
    if (index < 0) {
      throw new Error("未找到这张已记住的桌子");
    }

    const rememberedDesks = state.rememberedDesks.map((desk, deskIndex) =>
      deskIndex === index ? { ...desk, nickname: normalizedNickname } : { ...desk }
    );
    saveRememberedDesks(rememberedDesks);
    this.store.setState({ rememberedDesks });
  }

  async sendCommand(command: MovementCommand): Promise<void> {
    const deviceId = this.store.getState().connectedDeviceId;
    if (!deviceId || this.switchInProgress) {
      throw new Error("当前桌子不可控制");
    }

    this.resetMovementState();
    await this.ble.writeCommand(command);
    if (this.store.getState().connectedDeviceId !== deviceId) {
      return;
    }

    this.trackCommand(command, this.store.getState().currentHeight);
    if (command === "stop") {
      this.clearManualCommand();
    } else {
      this.manualCommand = command;
      this.scheduleManualCommand();
    }
  }

  async moveToHeight(targetHeight: number): Promise<void> {
    if (!this.store.getState().connectedDeviceId || this.switchInProgress) {
      throw new Error("当前桌子不可控制");
    }

    this.clearManualCommand();
    this.cancelFineAdjustment();
    const movementEpoch = ++this.movementEpoch;
    this.targetHeight = targetHeight;
    this.isAutoMoving = true;
    this.store.setState({ targetHeight, pendingCommand: "stop" });
    await this.evaluateMovement(undefined, movementEpoch);
  }

  cancelTarget() {
    this.resetMovementState();
  }

  getAvailableDevices(): DiscoveredDevice[] {
    return this.store.getState().availableDevices;
  }

  getConnectedDeviceId(): string | null {
    return this.store.getState().connectedDeviceId;
  }

  private assertCurrentConnectionOperation(operation: number, deviceId: string) {
    if (operation !== this.connectionOperation || this.expectedDeviceId !== deviceId) {
      throw new Error("桌子切换已被新的操作取消");
    }
  }

  private async stopForSwitch(deviceId: string, operation: number) {
    this.resetMovementState();
    this.assertCurrentConnectionOperation(operation, this.expectedDeviceId ?? deviceId);
    if (this.store.getState().connectedDeviceId !== deviceId) {
      throw new Error("原桌子连接状态已变化");
    }

    await this.ble.writeCommand("stop");
    if (this.store.getState().connectedDeviceId !== deviceId) {
      throw new Error("原桌子在停止时已断开");
    }
    this.trackCommand("stop", this.store.getState().currentHeight);
  }

  private upsertRememberedDesk(
    deviceId: string,
    replacementDeviceId: string | null
  ): RememberedDesk[] {
    const state = this.store.getState();
    const discovered = state.availableDevices.find((device) => device.deviceId === deviceId);
    const existing = state.rememberedDesks.find((desk) => desk.deviceId === deviceId);
    const replacement = replacementDeviceId
      ? state.rememberedDesks.find((desk) => desk.deviceId === replacementDeviceId)
      : undefined;
    const deviceName =
      discovered?.name?.trim() || existing?.deviceName || replacement?.deviceName || DEFAULT_REMEMBERED_DESK_NAME;

    if (replacement && replacement.deviceId !== deviceId) {
      const updatedDesk: RememberedDesk = {
        deviceId,
        deviceName,
        ...(replacement.nickname || existing?.nickname
          ? { nickname: replacement.nickname || existing?.nickname }
          : {})
      };
      return state.rememberedDesks.reduce<RememberedDesk[]>((desks, desk) => {
        if (desk.deviceId === replacement.deviceId) {
          desks.push(updatedDesk);
          return desks;
        }
        if (desk.deviceId !== deviceId) {
          desks.push({ ...desk });
        }
        return desks;
      }, []);
    }

    if (existing) {
      return state.rememberedDesks.map((desk) =>
        desk.deviceId === deviceId ? { ...desk, deviceName } : { ...desk }
      );
    }

    return [...state.rememberedDesks.map((desk) => ({ ...desk })), { deviceId, deviceName }];
  }

  private async evaluateMovement(snapshot?: PositionPayload, movementEpoch = this.movementEpoch) {
    if (!this.isCurrentMovement(movementEpoch)) {
      return;
    }

    const currentHeight = snapshot?.height ?? this.store.getState().currentHeight;
    const speed = snapshot?.speed ?? this.store.getState().lastKnownSpeed ?? 0;
    const targetHeight = this.targetHeight;

    if (currentHeight == null || targetHeight === null) {
      return;
    }

    const difference = targetHeight - currentHeight;
    const absDifference = Math.abs(difference);

    if (absDifference <= DEFAULT_TOLERANCE) {
      console.info("[DeskService] Target within tolerance", {
        currentHeight,
        targetHeight,
        difference,
        speed
      });

      if (Math.abs(speed) <= SPEED_STABLE_THRESHOLD_CM_S) {
        await this.completeAutoMovement(movementEpoch);
      } else {
        console.info("[DeskService] Waiting for desk to stabilise before finalising", { speed });
        await this.issueStopCommandIfNeeded(movementEpoch);
        this.scheduleMovementCheck(movementEpoch);
      }
      return;
    }

    const desiredCommand: MovementCommand = difference > 0 ? "up" : "down";

    if (
      (desiredCommand === "up" && speed < -SPEED_STABLE_THRESHOLD_CM_S) ||
      (desiredCommand === "down" && speed > SPEED_STABLE_THRESHOLD_CM_S)
    ) {
      console.warn("[DeskService] Speed opposite to desired direction, issuing stop", {
        currentHeight,
        targetHeight,
        speed,
        desiredCommand
      });
      await this.issueStopCommandIfNeeded(movementEpoch);
      this.scheduleMovementCheck(movementEpoch);
      return;
    }

    if (absDifference <= FINE_ADJUST_THRESHOLD_CM) {
      await this.handleFineAdjustment(desiredCommand, currentHeight, movementEpoch);
      return;
    }

    this.cancelFineAdjustment();

    let adjustedHeight = currentHeight;
    if (this.lastCommand === desiredCommand) {
      const predictiveOffset = Math.min(
        MOVEMENT_DIRECTION_OFFSET_CM,
        Math.max(MIN_DIRECTION_OFFSET_CM, Math.abs(speed) * SPEED_OFFSET_FACTOR)
      );
      adjustedHeight += desiredCommand === "up" ? predictiveOffset : -predictiveOffset;
    }

    if (
      (desiredCommand === "up" && adjustedHeight >= targetHeight) ||
      (desiredCommand === "down" && adjustedHeight <= targetHeight)
    ) {
      console.info("[DeskService] Predictive stop triggered", {
        currentHeight,
        adjustedHeight,
        targetHeight,
        speed,
        desiredCommand
      });
      await this.issueStopCommandIfNeeded(movementEpoch);
      this.scheduleMovementCheck(movementEpoch);
      return;
    }

    const now = Date.now();
    const heightDelta =
      currentHeight != null && this.lastCommandHeight != null
        ? Math.abs(currentHeight - this.lastCommandHeight)
        : null;
    const shouldResend =
      this.lastCommand === desiredCommand &&
      ((now - this.lastCommandAt > COMMAND_REISSUE_MIN_INTERVAL_MS) ||
        (heightDelta !== null && heightDelta >= COMMAND_REISSUE_MIN_DISTANCE_CM));

    console.info("[DeskService] Evaluate movement", {
      currentHeight,
      adjustedHeight,
      targetHeight,
      difference,
      speed,
      desiredCommand,
      lastCommand: this.lastCommand,
      heightDelta,
      elapsedSinceLastCommand: now - this.lastCommandAt,
      shouldResend
    });

    if (this.lastCommand !== desiredCommand || shouldResend) {
      await this.safeWrite(desiredCommand, currentHeight, movementEpoch);
    }

    this.scheduleMovementCheck(movementEpoch);
  }

  private async subscribeToPosition(deviceId: string) {
    if (this.store.getState().connectedDeviceId !== deviceId) {
      return;
    }

    try {
      await this.ble.subscribePosition();
    } catch (error) {
      console.error("Failed to subscribe position", error);
    }
  }

  private tryAutoReconnect() {
    if (this.autoReconnectAttempted) {
      return;
    }
    this.autoReconnectAttempted = true;

    const lastDeviceId = this.store.getState().activeDeskId ?? loadLastDeviceId();
    if (!lastDeviceId || !this.store.getState().autoReconnect) {
      return;
    }

    if (typeof wx === "undefined") {
      return;
    }

    setTimeout(() => {
      const state = this.store.getState();
      if (state.connectedDeviceId || state.isConnecting || !state.autoReconnect) {
        return;
      }

      console.info("[DeskService] Attempting auto reconnect");
      void this.selectDesk(lastDeviceId, { autoReconnect: true }).catch((error) => {
        console.warn("[DeskService] Auto reconnect failed", error);
      });
    }, 800);
  }

  private isCurrentMovement(movementEpoch: number): boolean {
    return (
      movementEpoch === this.movementEpoch &&
      this.isAutoMoving &&
      this.targetHeight !== null &&
      !!this.store.getState().connectedDeviceId &&
      !this.switchInProgress
    );
  }

  private async safeWrite(
    command: MovementCommand,
    currentHeight: number | null,
    movementEpoch?: number,
    manualCommandEpoch?: number
  ) {
    const deviceId = this.store.getState().connectedDeviceId;
    if (!deviceId) {
      return;
    }
    if (movementEpoch !== undefined && !this.isCurrentMovement(movementEpoch)) {
      return;
    }
    if (
      manualCommandEpoch !== undefined &&
      (manualCommandEpoch !== this.manualCommandEpoch || !this.manualCommand)
    ) {
      return;
    }

    try {
      await this.ble.writeCommand(command);
      if (this.store.getState().connectedDeviceId !== deviceId) {
        return;
      }
      if (movementEpoch !== undefined && !this.isCurrentMovement(movementEpoch)) {
        return;
      }
      if (
        manualCommandEpoch !== undefined &&
        (manualCommandEpoch !== this.manualCommandEpoch || !this.manualCommand)
      ) {
        return;
      }
      this.trackCommand(command, currentHeight);
    } catch (error) {
      console.error("Failed to write command", command, error);
      if (movementEpoch !== undefined && this.isCurrentMovement(movementEpoch)) {
        this.resetMovementState();
      }
      if (manualCommandEpoch !== undefined && manualCommandEpoch === this.manualCommandEpoch) {
        this.clearManualCommand();
      }
    }
  }

  private async issueStopCommandIfNeeded(movementEpoch: number) {
    if (!this.isCurrentMovement(movementEpoch)) {
      return;
    }
    if (
      this.lastCommand === "stop" &&
      Date.now() - this.lastCommandAt < COMMAND_REISSUE_MIN_INTERVAL_MS
    ) {
      return;
    }

    const deviceId = this.store.getState().connectedDeviceId;
    if (!deviceId) {
      return;
    }

    try {
      await this.ble.writeCommand("stop");
      if (this.store.getState().connectedDeviceId === deviceId && this.isCurrentMovement(movementEpoch)) {
        this.trackCommand("stop", this.store.getState().currentHeight);
      }
    } catch (error) {
      console.error("Failed to send stop command", error);
    }
  }

  private scheduleMovementCheck(movementEpoch: number) {
    if (this.movementTimer) {
      clearTimeout(this.movementTimer);
    }

    this.movementTimer = setTimeout(() => {
      if (!this.isCurrentMovement(movementEpoch)) {
        return;
      }

      const timeSinceLastNotification = Date.now() - this.lastNotificationTs;
      if (timeSinceLastNotification > MOVEMENT_TIMEOUT_MS) {
        console.warn("[DeskService] Movement timeout, forcing stop", {
          lastNotificationMsAgo: timeSinceLastNotification
        });
        recordCommandTimeout("go_preset");
        void this.completeAutoMovement(movementEpoch);
        return;
      }
      void this.evaluateMovement(undefined, movementEpoch);
    }, MOVEMENT_CHECK_INTERVAL_MS);
  }

  private resetMovementState() {
    this.movementEpoch += 1;
    if (this.movementTimer) {
      clearTimeout(this.movementTimer);
      this.movementTimer = null;
    }
    this.cancelFineAdjustment();
    this.clearManualCommand();
    this.targetHeight = null;
    this.isAutoMoving = false;
    this.lastCommand = "stop";
    this.lastCommandAt = 0;
    this.lastCommandHeight = null;
    this.store.setState({ targetHeight: null, pendingCommand: "stop" });
  }

  private trackCommand(command: MovementCommand, height: number | null) {
    this.lastCommand = command;
    this.lastCommandAt = Date.now();
    this.lastCommandHeight = typeof height === "number" ? height : this.store.getState().currentHeight;
    this.store.setState({ pendingCommand: command });
    console.info("[DeskService] Command sent", {
      command,
      height: this.lastCommandHeight,
      timestamp: this.lastCommandAt
    });
  }

  private scheduleManualCommand() {
    if (!this.manualCommand || this.manualCommand === "stop") {
      return;
    }

    const command = this.manualCommand;
    const manualCommandEpoch = this.manualCommandEpoch;
    if (this.manualCommandTimer) {
      clearInterval(this.manualCommandTimer);
    }

    this.manualCommandTimer = setInterval(() => {
      if (
        manualCommandEpoch !== this.manualCommandEpoch ||
        this.manualCommand !== command ||
        this.switchInProgress
      ) {
        return;
      }
      const now = Date.now();
      if (now - this.lastCommandAt < COMMAND_REISSUE_MIN_INTERVAL_MS) {
        return;
      }
      console.info("[DeskService] Reissuing manual command", {
        command,
        elapsed: now - this.lastCommandAt
      });
      void this.safeWrite(command, this.store.getState().currentHeight, undefined, manualCommandEpoch);
    }, MANUAL_COMMAND_INTERVAL_MS);
  }

  private clearManualCommand() {
    this.manualCommandEpoch += 1;
    this.manualCommand = null;
    if (this.manualCommandTimer) {
      clearInterval(this.manualCommandTimer);
      this.manualCommandTimer = null;
    }
  }

  private async completeAutoMovement(movementEpoch: number) {
    if (!this.isCurrentMovement(movementEpoch)) {
      return;
    }
    this.cancelFineAdjustment();
    await this.issueStopCommandIfNeeded(movementEpoch);
    if (this.isCurrentMovement(movementEpoch)) {
      this.resetMovementState();
    }
  }

  private async handleFineAdjustment(
    command: MovementCommand,
    currentHeight: number,
    movementEpoch: number
  ) {
    if (command === "stop" || !this.isCurrentMovement(movementEpoch)) {
      return;
    }

    if (this.fineAdjustTimer) {
      if (this.lastCommand !== command) {
        await this.safeWrite(command, currentHeight, movementEpoch);
      }
      return;
    }

    await this.safeWrite(command, currentHeight, movementEpoch);
    if (!this.isCurrentMovement(movementEpoch)) {
      return;
    }
    console.info("[DeskService] Fine adjustment pulse", {
      command,
      currentHeight,
      targetHeight: this.targetHeight
    });
    this.fineAdjustTimer = setTimeout(() => {
      if (!this.isCurrentMovement(movementEpoch)) {
        return;
      }
      void this.issueStopCommandIfNeeded(movementEpoch);
      this.fineAdjustTimer = null;
      this.scheduleMovementCheck(movementEpoch);
    }, FINE_PULSE_DURATION_MS);
    this.scheduleMovementCheck(movementEpoch);
  }

  private cancelFineAdjustment() {
    if (this.fineAdjustTimer) {
      clearTimeout(this.fineAdjustTimer);
      this.fineAdjustTimer = null;
    }
  }
}

let instance: DeskService | null = null;

export const getDeskService = (): DeskService => {
  if (!instance) {
    instance = new DeskService();
  }
  return instance;
};
