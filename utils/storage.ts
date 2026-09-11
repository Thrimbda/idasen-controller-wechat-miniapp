import { DEFAULT_REMEMBERED_DESK_NAME, type Preset, type RememberedDesk, type Unit } from "./store";

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
  LAST_DEVICE_ID: "idasen.lastDeviceId",
  SAVED_DESKS: "idasen.savedDesks.v1",
  ACTIVE_DESK_ID: "idasen.activeDeskId",
  FIRST_OPEN_AT: "idasen.analytics.firstOpenAt",
  SESSION_HISTORY: "idasen.analytics.sessionHistory",
  USER_FLAGS: "idasen.analytics.userFlags"
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

export interface RememberedDeskDirectory {
  rememberedDesks: RememberedDesk[];
  activeDeskId: string | null;
}

const normalizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const normalizeRememberedDesks = (value: unknown): RememberedDesk[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const desks: RememberedDesk[] = [];
  const indexByDeviceId = new Map<string, number>();

  value.forEach((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return;
    }

    const record = candidate as Partial<RememberedDesk>;
    const deviceId = normalizeString(record.deviceId);
    if (!deviceId) {
      return;
    }

    const deviceName = normalizeString(record.deviceName) || DEFAULT_REMEMBERED_DESK_NAME;
    const nickname = normalizeString(record.nickname);
    const existingIndex = indexByDeviceId.get(deviceId);

    if (existingIndex === undefined) {
      desks.push({
        deviceId,
        deviceName,
        ...(nickname ? { nickname } : {})
      });
      indexByDeviceId.set(deviceId, desks.length - 1);
      return;
    }

    const existing = desks[existingIndex];
    if (!existing.nickname && nickname) {
      existing.nickname = nickname;
    }
    if (existing.deviceName === DEFAULT_REMEMBERED_DESK_NAME && deviceName !== existing.deviceName) {
      existing.deviceName = deviceName;
    }
  });

  return desks;
};

export const loadRememberedDesks = (): RememberedDesk[] => {
  try {
    return normalizeRememberedDesks(storage.getStorageSync<unknown>(STORAGE_KEYS.SAVED_DESKS));
  } catch (error) {
    console.warn("Failed to load remembered desks", error);
    return [];
  }
};

export const saveRememberedDesks = (desks: RememberedDesk[]): void => {
  storage.setStorageSync(STORAGE_KEYS.SAVED_DESKS, normalizeRememberedDesks(desks));
};

export const loadActiveDeskId = (): string | null => {
  try {
    const value = normalizeString(storage.getStorageSync<unknown>(STORAGE_KEYS.ACTIVE_DESK_ID));
    return value || null;
  } catch (error) {
    console.warn("Failed to load active desk id", error);
    return null;
  }
};

export const saveActiveDeskId = (deviceId: string): void => {
  storage.setStorageSync(STORAGE_KEYS.ACTIVE_DESK_ID, deviceId);
};

export const clearActiveDeskId = (): void => {
  storage.removeStorageSync?.(STORAGE_KEYS.ACTIVE_DESK_ID);
};

export const loadRememberedDeskDirectory = (): RememberedDeskDirectory => {
  let storedDesks: unknown;
  try {
    storedDesks = storage.getStorageSync<unknown>(STORAGE_KEYS.SAVED_DESKS);
  } catch (error) {
    console.warn("Failed to read remembered desk directory", error);
  }

  const rememberedDesks = normalizeRememberedDesks(storedDesks);
  const legacyDeviceId = loadLastDeviceId();
  const storedActiveDeskId = loadActiveDeskId();
  let didRepairDirectory =
    storedDesks !== undefined && JSON.stringify(storedDesks) !== JSON.stringify(rememberedDesks);

  if (legacyDeviceId && !rememberedDesks.some((desk) => desk.deviceId === legacyDeviceId)) {
    rememberedDesks.push({
      deviceId: legacyDeviceId,
      deviceName: DEFAULT_REMEMBERED_DESK_NAME
    });
    didRepairDirectory = true;
  }

  const activeDeskId = rememberedDesks.some((desk) => desk.deviceId === storedActiveDeskId)
    ? storedActiveDeskId
    : legacyDeviceId && rememberedDesks.some((desk) => desk.deviceId === legacyDeviceId)
      ? legacyDeviceId
      : rememberedDesks[0]?.deviceId ?? null;

  const needsActiveRepair = activeDeskId !== storedActiveDeskId;
  const needsLegacyMirror = !!activeDeskId && activeDeskId !== legacyDeviceId;

  if (didRepairDirectory || needsActiveRepair || needsLegacyMirror) {
    try {
      if (didRepairDirectory) {
        saveRememberedDesks(rememberedDesks);
      }
      if (activeDeskId && needsActiveRepair) {
        saveActiveDeskId(activeDeskId);
      }
      if (activeDeskId && needsLegacyMirror) {
        saveLastDeviceId(activeDeskId);
      }
    } catch (error) {
      console.warn("Failed to reconcile remembered desk directory", error);
    }
  }

  return {
    rememberedDesks,
    activeDeskId
  };
};

export const saveConfirmedDeskDirectory = (
  rememberedDesks: RememberedDesk[],
  activeDeskId: string
): void => {
  saveRememberedDesks(rememberedDesks);
  saveActiveDeskId(activeDeskId);
  saveLastDeviceId(activeDeskId);
};

export const loadFirstOpenAt = (): number | null => {
  try {
    const value = storage.getStorageSync<number>(STORAGE_KEYS.FIRST_OPEN_AT);
    return typeof value === "number" ? value : null;
  } catch (error) {
    console.warn("Failed to load first open timestamp", error);
    return null;
  }
};

export const saveFirstOpenAt = (timestamp: number): void => {
  storage.setStorageSync(STORAGE_KEYS.FIRST_OPEN_AT, timestamp);
};

export const loadSessionHistory = (): number[] => {
  try {
    const value = storage.getStorageSync<number[]>(STORAGE_KEYS.SESSION_HISTORY);
    return Array.isArray(value) ? value : [];
  } catch (error) {
    console.warn("Failed to load session history", error);
    return [];
  }
};

export const saveSessionHistory = (history: number[]): void => {
  storage.setStorageSync(STORAGE_KEYS.SESSION_HISTORY, history);
};

export interface UserFlags {
  hasSetPresetSit?: boolean;
  hasSetPresetStand?: boolean;
}

export const loadUserFlags = (): UserFlags => {
  try {
    const flags = storage.getStorageSync<UserFlags>(STORAGE_KEYS.USER_FLAGS);
    if (!flags || typeof flags !== "object") {
      return {};
    }
    return { ...flags };
  } catch (error) {
    console.warn("Failed to load user flags", error);
    return {};
  }
};

export const saveUserFlags = (flags: UserFlags): void => {
  storage.setStorageSync(STORAGE_KEYS.USER_FLAGS, flags);
};
