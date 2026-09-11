import type { MovementCommand } from "./desk-protocol";

export interface Preset {
  id: string;
  name: string;
  height: number;
  isDefault?: boolean;
}

export type Unit = "cm" | "inch";

export interface DiscoveredDevice {
  deviceId: string;
  name: string;
  RSSI: number;
  localName?: string | null;
}

export interface RememberedDesk {
  deviceId: string;
  deviceName: string;
  nickname?: string;
}

export const DEFAULT_REMEMBERED_DESK_NAME = "已记住的桌子";

export const getDeskDisplayName = (desk: RememberedDesk | null | undefined): string => {
  const nickname = desk?.nickname?.trim();
  if (nickname) {
    return nickname;
  }

  const deviceName = desk?.deviceName?.trim();
  return deviceName || DEFAULT_REMEMBERED_DESK_NAME;
};

export interface AppState {
  presets: Preset[];
  unit: Unit;
  rememberedDesks: RememberedDesk[];
  activeDeskId: string | null;
  pendingDeskId: string | null;
  connectedDeviceId: string | null;
  currentHeight: number | null;
  isScanning: boolean;
  isConnecting: boolean;
  lastKnownSpeed: number | null;
  autoReconnect: boolean;
  availableDevices: DiscoveredDevice[];
  targetHeight: number | null;
  pendingCommand: MovementCommand;
}

export type StateListener = (state: AppState) => void;

export interface AppStore {
  getState(): AppState;
  subscribe(listener: StateListener): () => void;
  setState(partial: Partial<AppState>): AppState;
  reset(): AppState;
}

export const SIT_PRESET_ID = "preset-sit";
export const STAND_PRESET_ID = "preset-stand";

const defaultPresets: Preset[] = [
  { id: SIT_PRESET_ID, name: "坐下", height: 72 },
  { id: STAND_PRESET_ID, name: "站立", height: 110 }
];

export const CORE_PRESETS: ReadonlyArray<Preset> = defaultPresets;

const defaultState: AppState = {
  presets: [...defaultPresets],
  unit: "cm",
  rememberedDesks: [],
  activeDeskId: null,
  pendingDeskId: null,
  connectedDeviceId: null,
  currentHeight: null,
  isScanning: false,
  isConnecting: false,
  lastKnownSpeed: null,
  autoReconnect: true,
  availableDevices: [],
  targetHeight: null,
  pendingCommand: "stop"
};

export const createAppStore = (initialState: Partial<AppState> = {}): AppStore => {
  let state: AppState = {
    ...defaultState,
    ...initialState,
    presets: initialState.presets ? [...initialState.presets] : [...defaultState.presets],
    rememberedDesks: initialState.rememberedDesks
      ? initialState.rememberedDesks.map((desk) => ({ ...desk }))
      : []
  };
  const listeners = new Set<StateListener>();

  const notify = () => {
    listeners.forEach((listener) => listener(state));
  };

  return {
    getState() {
      return state;
    },
    subscribe(listener: StateListener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    setState(partial: Partial<AppState>) {
      state = {
        ...state,
        ...partial,
        presets: partial.presets ? [...partial.presets] : state.presets,
        rememberedDesks: partial.rememberedDesks
          ? partial.rememberedDesks.map((desk) => ({ ...desk }))
          : state.rememberedDesks
      };
      notify();
      return state;
    },
    reset() {
      state = {
        ...defaultState,
        presets: [...defaultState.presets],
        rememberedDesks: []
      };
      notify();
      return state;
    }
  };
};
