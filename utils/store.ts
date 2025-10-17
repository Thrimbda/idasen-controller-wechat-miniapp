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

export interface AppState {
  presets: Preset[];
  unit: Unit;
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
    presets: initialState.presets ? [...initialState.presets] : [...defaultState.presets]
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
        presets: partial.presets ? [...partial.presets] : state.presets
      };
      notify();
      return state;
    },
    reset() {
      state = { ...defaultState, presets: [...defaultState.presets] };
      notify();
      return state;
    }
  };
};
