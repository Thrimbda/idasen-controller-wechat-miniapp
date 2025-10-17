import { DEFAULT_TOLERANCE, MovementCommand } from "./desk-protocol";
import { DeskBleClient, type PositionPayload } from "./ble";
import { getAppStore } from "./app-context";
import { saveLastDeviceId, clearLastDeviceId, loadLastDeviceId } from "./storage";
import type { AppStore, DiscoveredDevice } from "./store";

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

export class DeskService {
  private readonly store: AppStore;
  private readonly ble: DeskBleClient;
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

  constructor() {
    this.store = getAppStore();
    this.ble = new DeskBleClient();
    this.bindBleEvents();
    this.tryAutoReconnect();
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

    this.ble.on("connectionState", ({ deviceId, connected }) => {
      if (connected) {
        this.store.setState({
          connectedDeviceId: deviceId,
          isConnecting: false
        });
        saveLastDeviceId(deviceId);
        void this.subscribeToPosition();
      } else if (this.store.getState().connectedDeviceId === deviceId) {
        this.store.setState({
          connectedDeviceId: null,
          isConnecting: false,
          availableDevices: this.store.getState().availableDevices
        });
        clearLastDeviceId();
        this.resetMovementState();
      }
    });

    this.ble.on("position", (payload) => {
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
        void this.evaluateMovement(payload);
      }
    });

    this.ble.on("error", (error) => {
      console.error("BLE error", error);
      this.store.setState({ isConnecting: false });
      if (this.isAutoMoving) {
        this.resetMovementState();
      }
    });
  }

  async startScan(): Promise<void> {
    this.store.setState({ isScanning: true, availableDevices: [] });
    await this.ble.startScan();
  }

  async stopScan(): Promise<void> {
    await this.ble.stopScan();
    this.store.setState({ isScanning: false });
  }

  async connect(deviceId: string): Promise<void> {
    this.store.setState({ isConnecting: true });
    await this.ble.connect(deviceId);
  }

  async disconnect(): Promise<void> {
    await this.ble.disconnect();
    this.clearManualCommand();
  }

  async sendCommand(command: MovementCommand): Promise<void> {
    this.resetMovementState();
    await this.ble.writeCommand(command);
    this.trackCommand(command, this.store.getState().currentHeight);
    if (command === "stop") {
      this.clearManualCommand();
    } else {
      this.manualCommand = command;
      this.scheduleManualCommand();
    }
  }

  async moveToHeight(targetHeight: number): Promise<void> {
    this.clearManualCommand();
    this.cancelFineAdjustment();
    this.targetHeight = targetHeight;
    this.isAutoMoving = true;
    this.store.setState({ targetHeight, pendingCommand: "stop" });
    await this.evaluateMovement();
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

  private async evaluateMovement(snapshot?: PositionPayload) {
    if (this.targetHeight === null) {
      return;
    }

    const currentHeight = snapshot?.height ?? this.store.getState().currentHeight;
    const speed = snapshot?.speed ?? this.store.getState().lastKnownSpeed ?? 0;

    if (currentHeight == null) {
      return;
    }

    const difference = this.targetHeight - currentHeight;
    const absDifference = Math.abs(difference);

    if (absDifference <= DEFAULT_TOLERANCE) {
      console.info("[DeskService] Target within tolerance", {
        currentHeight,
        targetHeight: this.targetHeight,
        difference,
        speed
      });

      if (Math.abs(speed) <= SPEED_STABLE_THRESHOLD_CM_S) {
        await this.completeAutoMovement();
      } else {
        console.info("[DeskService] Waiting for desk to stabilise before finalising", { speed });
        await this.issueStopCommandIfNeeded();
        this.scheduleMovementCheck();
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
        targetHeight: this.targetHeight,
        speed,
        desiredCommand
      });
      await this.issueStopCommandIfNeeded();
      this.scheduleMovementCheck();
      return;
    }

    if (absDifference <= FINE_ADJUST_THRESHOLD_CM) {
      await this.handleFineAdjustment(desiredCommand, currentHeight);
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
      (desiredCommand === "up" && adjustedHeight >= this.targetHeight) ||
      (desiredCommand === "down" && adjustedHeight <= this.targetHeight)
    ) {
      console.info("[DeskService] Predictive stop triggered", {
        currentHeight,
        adjustedHeight,
        targetHeight: this.targetHeight,
        speed,
        desiredCommand
      });
      await this.issueStopCommandIfNeeded();
      this.scheduleMovementCheck();
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
      targetHeight: this.targetHeight,
      difference,
      speed,
      desiredCommand,
      lastCommand: this.lastCommand,
      heightDelta,
      elapsedSinceLastCommand: now - this.lastCommandAt,
      shouldResend
    });

    if (this.lastCommand !== desiredCommand || shouldResend) {
      await this.safeWrite(desiredCommand, currentHeight);
    }

    this.scheduleMovementCheck();
  }

  private async subscribeToPosition() {
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

    const lastDeviceId = loadLastDeviceId();
    if (!lastDeviceId || !this.store.getState().autoReconnect) {
      return;
    }

    if (typeof wx === "undefined") {
      return;
    }

    setTimeout(() => {
      const state = this.store.getState();
      if (state.connectedDeviceId || !state.autoReconnect) {
        return;
      }

      console.info("[DeskService] Attempting auto reconnect", { lastDeviceId });
      void this.connect(lastDeviceId).catch((error) => {
        console.warn("[DeskService] Auto reconnect failed", error);
      });
    }, 800);
  }

  private async safeWrite(command: MovementCommand, currentHeight: number | null) {
    try {
      await this.ble.writeCommand(command);
      this.trackCommand(command, currentHeight);
    } catch (error) {
      console.error("Failed to write command", command, error);
      this.resetMovementState();
    }
  }

  private async issueStopCommandIfNeeded() {
    if (
      this.lastCommand === "stop" &&
      Date.now() - this.lastCommandAt < COMMAND_REISSUE_MIN_INTERVAL_MS
    ) {
      return;
    }

    try {
      await this.ble.writeCommand("stop");
    } catch (error) {
      console.error("Failed to send stop command", error);
    } finally {
      this.trackCommand("stop", this.store.getState().currentHeight);
    }
  }

  private scheduleMovementCheck() {
    if (this.movementTimer) {
      clearTimeout(this.movementTimer);
    }

    this.movementTimer = setTimeout(() => {
      if (!this.isAutoMoving || this.targetHeight === null) {
        return;
      }

      const timeSinceLastNotification = Date.now() - this.lastNotificationTs;
      if (timeSinceLastNotification > MOVEMENT_TIMEOUT_MS) {
        console.warn("[DeskService] Movement timeout, forcing stop", {
          lastNotificationMsAgo: timeSinceLastNotification
        });
        void this.completeAutoMovement();
        return;
      }
      void this.evaluateMovement();
    }, MOVEMENT_CHECK_INTERVAL_MS);
  }

  private resetMovementState() {
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

    if (this.manualCommandTimer) {
      clearInterval(this.manualCommandTimer);
    }

    this.manualCommandTimer = setInterval(() => {
      if (!this.manualCommand || this.manualCommand === "stop") {
        return;
      }
      const now = Date.now();
      if (now - this.lastCommandAt < COMMAND_REISSUE_MIN_INTERVAL_MS) {
        return;
      }
      console.info("[DeskService] Reissuing manual command", {
        command: this.manualCommand,
        elapsed: now - this.lastCommandAt
      });
      void this.safeWrite(this.manualCommand, this.store.getState().currentHeight);
    }, MANUAL_COMMAND_INTERVAL_MS);
  }

  private clearManualCommand() {
    this.manualCommand = null;
    if (this.manualCommandTimer) {
      clearInterval(this.manualCommandTimer);
      this.manualCommandTimer = null;
    }
  }

  private async completeAutoMovement() {
    this.cancelFineAdjustment();
    await this.issueStopCommandIfNeeded();
    this.resetMovementState();
  }

  private async handleFineAdjustment(command: MovementCommand, currentHeight: number) {
    if (command === "stop") {
      return;
    }

    if (this.fineAdjustTimer) {
      if (this.lastCommand !== command) {
        await this.safeWrite(command, currentHeight);
      }
      return;
    }

    await this.safeWrite(command, currentHeight);
    console.info("[DeskService] Fine adjustment pulse", {
      command,
      currentHeight,
      targetHeight: this.targetHeight
    });
    this.fineAdjustTimer = setTimeout(() => {
      void this.issueStopCommandIfNeeded();
      this.fineAdjustTimer = null;
      this.scheduleMovementCheck();
    }, FINE_PULSE_DURATION_MS);
    this.scheduleMovementCheck();
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
