import type { Preset, Unit } from "./store";

const memoryFallback = new Map<string, unknown>();

interface StorageAdapter {
  getStorageSync<T = unknown>(key: string): T | undefined;
  setStorageSync<T = unknown>(key: string, data: T): void;
  removeStorageSync?(key: string): void;
}

const createAdapter = (): StorageAdapter => {
  if (typeof wx !== "undefined" && typeof wx.getStorageSync === "function") {
    return wx;
  }

  return {
    getStorageSync<T = unknown>(key: string): T | undefined {
      return memoryFallback.get(key) as T | undefined;
    },
    setStorageSync<T = unknown>(key: string, data: T) {
      memoryFallback.set(key, data);
    },
    removeStorageSync(key: string) {
      memoryFallback.delete(key);
    }
  };
};

const storage = createAdapter();

export const STORAGE_KEYS = {
  PRESETS: "idasen.presets",
  UNIT: "idasen.unit",
  AUTO_RECONNECT: "idasen.autoReconnect",
  LAST_DEVICE_ID: "idasen.lastDeviceId"
} as const;

export const loadPresets = (): Preset[] => {
  try {
    const data = storage.getStorageSync<Preset[]>(STORAGE_KEYS.PRESETS);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.warn("Failed to load presets", error);
    return [];
  }
};

export const savePresets = (presets: Preset[]): void => {
  storage.setStorageSync(STORAGE_KEYS.PRESETS, presets);
};

export const loadUnit = (): Unit | null => {
  const unit = storage.getStorageSync<Unit>(STORAGE_KEYS.UNIT);
  return unit === "cm" || unit === "inch" ? unit : null;
};

export const saveUnit = (unit: Unit): void => {
  storage.setStorageSync(STORAGE_KEYS.UNIT, unit);
};

export const loadAutoReconnect = (): boolean | null => {
  const value = storage.getStorageSync<boolean>(STORAGE_KEYS.AUTO_RECONNECT);
  return typeof value === "boolean" ? value : null;
};

export const saveAutoReconnect = (enabled: boolean): void => {
  storage.setStorageSync(STORAGE_KEYS.AUTO_RECONNECT, enabled);
};

export const loadLastDeviceId = (): string | null => {
  try {
    const value = storage.getStorageSync<string>(STORAGE_KEYS.LAST_DEVICE_ID);
    return typeof value === "string" && value ? value : null;
  } catch (error) {
    console.warn("Failed to load last device id", error);
    return null;
  }
};

export const saveLastDeviceId = (deviceId: string): void => {
  storage.setStorageSync(STORAGE_KEYS.LAST_DEVICE_ID, deviceId);
};

export const clearLastDeviceId = (): void => {
  storage.removeStorageSync?.(STORAGE_KEYS.LAST_DEVICE_ID);
};
