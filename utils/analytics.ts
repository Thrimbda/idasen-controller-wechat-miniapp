import {
  loadFirstOpenAt,
  loadSessionHistory,
  loadUserFlags,
  saveFirstOpenAt,
  saveSessionHistory,
  saveUserFlags
} from "./storage";

type AnalyticsEventMap = {
  app_open: {
    source: string;
    is_first_open: boolean;
    has_set_preset_sit?: boolean;
    has_set_preset_stand?: boolean;
    avg_session_per_week?: number;
    is_heavy_user?: boolean;
  };
  app_close_session: {
    session_duration_sec: number;
    connected_time_sec: number;
    preset_use_count: number;
    manual_move_count: number;
    end_reason?: string;
  };
  connect_desk_success: {
    device_name?: string;
    rssi?: number;
    auto_reconnect: boolean;
    connect_duration_ms: number;
  };
  connect_desk_fail: {
    device_name?: string;
    error_code?: number | string;
    error_msg?: string;
    step: "scan" | "connect" | "pair";
    auto_reconnect?: boolean;
  };
  set_preset_height: { position_type: "sit" | "stand"; height_cm: number };
  use_preset_height: { position_type: "sit" | "stand"; target_height_cm: number };
  manual_move: { direction: "up" | "down"; duration_ms: number };
  unit_switch: { from_unit: "cm" | "inch"; to_unit: "cm" | "inch" };
  open_settings_page: { from: string };
  feedback_click: { channel?: string };
  share_click: { channel: string };
  xhs_qrcode_scan: { scene?: string };
  bt_disconnect_unexpected: { reason: string };
  command_timeout: { cmd_type: "go_preset" | "manual_move" };
  ui_error: { message: string; stack?: string };
};

type AnalyticsEventName = keyof AnalyticsEventMap;

const SESSION_HISTORY_LIMIT = 60;
const HEAVY_USER_WEEKLY_THRESHOLD = 3;

interface SessionState {
  sessionStartMs: number | null;
  connectedStartMs: number | null;
  connectedAccumMs: number;
  presetUseCount: number;
  manualMoveCount: number;
  lastSource: string;
}

interface ConnectAttempt {
  startedAt: number;
  deviceName?: string;
  rssi?: number;
  autoReconnect: boolean;
}

const sessionState: SessionState = {
  sessionStartMs: null,
  connectedStartMs: null,
  connectedAccumMs: 0,
  presetUseCount: 0,
  manualMoveCount: 0,
  lastSource: "unknown"
};

let lastConnectAttempt: ConnectAttempt | null = null;

const sanitizeProperties = (
  payload: Record<string, unknown>
): Record<string, number | string> => {
  const result: Record<string, number | string> = {};
  Object.entries(payload).forEach(([key, value]) => {
    if (value === null || typeof value === "undefined") {
      return;
    }

    if (typeof value === "boolean") {
      result[key] = value ? 1 : 0;
      return;
    }

    if (typeof value === "number") {
      if (Number.isInteger(value)) {
        result[key] = value;
        return;
      }
      result[key] = Number(value.toFixed(2)).toString();
      return;
    }

    if (typeof value === "string") {
      result[key] = value;
      return;
    }

    result[key] = JSON.stringify(value);
  });
  return result;
};

const safeReport = <T extends AnalyticsEventName>(
  event: T,
  payload: AnalyticsEventMap[T]
): void => {
  console.info("[Analytics]", event, payload);
  if (typeof wx === "undefined") {
    return;
  }

  const sanitized = sanitizeProperties(payload as Record<string, unknown>);

  try {
    // Keep the existing custom-analysis backend. wx.obs needs separate setup.
    if (typeof wx.reportAnalytics === "function") {
      wx.reportAnalytics(event, sanitized);
    }
  } catch (error) {
    console.warn("Analytics report failed", event, error);
  }
};

const ensureSession = () => {
  if (sessionState.sessionStartMs === null) {
    sessionState.sessionStartMs = Date.now();
    sessionState.connectedStartMs = null;
    sessionState.connectedAccumMs = 0;
    sessionState.presetUseCount = 0;
    sessionState.manualMoveCount = 0;
  }
};

const ensureFirstOpenFlag = (): boolean => {
  const firstOpenAt = loadFirstOpenAt();
  if (firstOpenAt) {
    return false;
  }
  saveFirstOpenAt(Date.now());
  return true;
};

const updateSessionHistory = (now: number) => {
  const history = loadSessionHistory()
    .filter((timestamp) => Number.isFinite(timestamp))
    .map((timestamp) => Number(timestamp))
    .filter((timestamp) => now - timestamp <= 60 * 24 * 3600 * 1000);

  history.push(now);

  while (history.length > SESSION_HISTORY_LIMIT) {
    history.shift();
  }

  saveSessionHistory(history);

  const last7Days = history.filter((timestamp) => now - timestamp <= 7 * 24 * 3600 * 1000).length;
  const avgSessionPerWeek = parseFloat(last7Days.toFixed(2));
  const isHeavyUser = last7Days >= HEAVY_USER_WEEKLY_THRESHOLD;

  return { avgSessionPerWeek, isHeavyUser };
};

const resolveSource = (options: WechatMiniprogram.App.LaunchShowOption): string => {
  if (options.query && typeof options.query.source === "string") {
    return options.query.source;
  }

  if (options.referrerInfo?.extraData && typeof options.referrerInfo.extraData.source === "string") {
    return options.referrerInfo.extraData.source;
  }

  const scene = options.scene;
  switch (scene) {
    case 1001:
      return "discover";
    case 1007:
      return "single_chat_card";
    case 1008:
      return "group_chat_card";
    case 1011:
    case 1025:
    case 1036:
      return "scan_qrcode";
    case 1038:
      return "share_card";
    case 1044:
      return "group_chat";
    case 1089:
      return "recent_list";
    default:
      return typeof scene === "number" ? `scene_${scene}` : "unknown";
  }
};

const accumulateConnected = (now: number) => {
  if (sessionState.connectedStartMs) {
    sessionState.connectedAccumMs += now - sessionState.connectedStartMs;
    sessionState.connectedStartMs = null;
  }
};

export const startSession = (options: WechatMiniprogram.App.LaunchShowOption): void => {
  const now = Date.now();
  sessionState.sessionStartMs = now;
  sessionState.connectedStartMs = null;
  sessionState.connectedAccumMs = 0;
  sessionState.presetUseCount = 0;
  sessionState.manualMoveCount = 0;

  const source = resolveSource(options);
  sessionState.lastSource = source;
  const isFirstOpen = ensureFirstOpenFlag();
  const usage = updateSessionHistory(now);
  const userFlags = loadUserFlags();

  safeReport("app_open", {
    source,
    is_first_open: isFirstOpen,
    has_set_preset_sit: userFlags.hasSetPresetSit,
    has_set_preset_stand: userFlags.hasSetPresetStand,
    avg_session_per_week: usage.avgSessionPerWeek,
    is_heavy_user: usage.isHeavyUser
  });
};

export const endSession = (reason: string): void => {
  if (sessionState.sessionStartMs === null) {
    return;
  }

  const now = Date.now();
  accumulateConnected(now);

  safeReport("app_close_session", {
    session_duration_sec: Math.max(0, Math.round((now - sessionState.sessionStartMs) / 1000)),
    connected_time_sec: Math.max(0, Math.round(sessionState.connectedAccumMs / 1000)),
    preset_use_count: sessionState.presetUseCount,
    manual_move_count: sessionState.manualMoveCount,
    end_reason: reason
  });

  sessionState.sessionStartMs = null;
  sessionState.connectedStartMs = null;
  sessionState.connectedAccumMs = 0;
  sessionState.presetUseCount = 0;
  sessionState.manualMoveCount = 0;
};

export const beginConnectAttempt = (params: {
  deviceName?: string;
  rssi?: number;
  autoReconnect?: boolean;
}): void => {
  ensureSession();
  lastConnectAttempt = {
    startedAt: Date.now(),
    deviceName: params.deviceName,
    rssi: params.rssi,
    autoReconnect: !!params.autoReconnect
  };
};

export const recordConnectSuccess = (params: {
  deviceName?: string;
  rssi?: number;
  autoReconnect?: boolean;
  connectDurationMs?: number;
}): void => {
  ensureSession();
  const now = Date.now();
  const duration =
    typeof params.connectDurationMs === "number"
      ? params.connectDurationMs
      : lastConnectAttempt
      ? now - lastConnectAttempt.startedAt
      : 0;

  safeReport("connect_desk_success", {
    device_name: params.deviceName ?? lastConnectAttempt?.deviceName,
    rssi: params.rssi ?? lastConnectAttempt?.rssi,
    auto_reconnect: params.autoReconnect ?? lastConnectAttempt?.autoReconnect ?? false,
    connect_duration_ms: duration
  });

  sessionState.connectedStartMs = now;
  lastConnectAttempt = null;
};

export const recordConnectFail = (params: {
  step: "scan" | "connect" | "pair";
  error?: unknown;
  deviceName?: string;
  autoReconnect?: boolean;
}): void => {
  ensureSession();
  let errorCode: number | string | undefined;
  let errorMsg: string | undefined;
  const error = params.error as { errCode?: unknown; errMsg?: unknown };
  if (typeof error?.errCode === "number" || typeof error?.errCode === "string") {
    errorCode = error.errCode;
  }
  if (typeof error?.errMsg === "string") {
    errorMsg = error.errMsg;
  } else if (params.error instanceof Error) {
    errorMsg = params.error.message;
  }

  safeReport("connect_desk_fail", {
    device_name: params.deviceName ?? lastConnectAttempt?.deviceName,
    error_code: errorCode,
    error_msg: errorMsg,
    step: params.step,
    auto_reconnect: params.autoReconnect ?? lastConnectAttempt?.autoReconnect
  });
  lastConnectAttempt = null;
};

export const recordPresetSaved = (position: "sit" | "stand", heightCm: number): void => {
  ensureSession();
  const flags = loadUserFlags();
  const updated = {
    ...flags,
    hasSetPresetSit: flags.hasSetPresetSit || position === "sit",
    hasSetPresetStand: flags.hasSetPresetStand || position === "stand"
  };
  if (position === "sit") {
    updated.hasSetPresetSit = true;
  } else {
    updated.hasSetPresetStand = true;
  }
  saveUserFlags(updated);

  safeReport("set_preset_height", {
    position_type: position,
    height_cm: parseFloat(heightCm.toFixed(1))
  });
};

export const recordPresetUse = (position: "sit" | "stand", targetHeightCm: number): void => {
  ensureSession();
  sessionState.presetUseCount += 1;
  safeReport("use_preset_height", {
    position_type: position,
    target_height_cm: parseFloat(targetHeightCm.toFixed(1))
  });
};

export const recordManualMove = (direction: "up" | "down", durationMs: number): void => {
  ensureSession();
  sessionState.manualMoveCount += 1;
  safeReport("manual_move", { direction, duration_ms: Math.max(0, Math.round(durationMs)) });
};

export const recordUnitSwitch = (from: "cm" | "inch", to: "cm" | "inch"): void => {
  ensureSession();
  safeReport("unit_switch", { from_unit: from, to_unit: to });
};

export const recordSettingsOpen = (from: string): void => {
  ensureSession();
  safeReport("open_settings_page", { from });
};

export const recordFeedbackClick = (channel?: string): void => {
  ensureSession();
  safeReport("feedback_click", { channel });
};

export const recordShareClick = (channel: string): void => {
  ensureSession();
  safeReport("share_click", { channel });
};

export const recordXhsScan = (scene?: string): void => {
  ensureSession();
  safeReport("xhs_qrcode_scan", { scene });
};

export const recordUnexpectedDisconnect = (reason: string): void => {
  ensureSession();
  safeReport("bt_disconnect_unexpected", { reason });
  endSession(reason);
};

export const recordManualDisconnect = (): void => {
  const now = Date.now();
  ensureSession();
  accumulateConnected(now);
  endSession("manual_disconnect");
};

export const recordCommandTimeout = (cmdType: "go_preset" | "manual_move"): void => {
  ensureSession();
  safeReport("command_timeout", { cmd_type: cmdType });
};

export const recordUiError = (error: unknown): void => {
  let message: string | undefined;
  let stack: string | undefined;

  if (error instanceof Error) {
    message = error.message;
    stack = error.stack;
  } else if (typeof error === "string") {
    message = error;
  } else if (error && typeof error === "object" && "errMsg" in error) {
    message = String((error as { errMsg?: unknown }).errMsg);
  }

  if (message) {
    safeReport("ui_error", { message, stack });
  }
};
