export interface RelayLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function createRelayLogger(prefix = "[relay]"): RelayLogger {
  const write = (
    level: "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>,
  ): void => {
    const line = `${prefix} ${message}`;
    if (meta && Object.keys(meta).length > 0) {
      console[level](line, JSON.stringify(meta));
      return;
    }
    console[level](line);
  };
  return {
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}

export function createSilentRelayLogger(): RelayLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * 日志口径：只记 sid 后 4 位。完整 sid 等同于配对凭证的一半，
 * 落进日志就等于把控制权写进文件（spec 第六节）。
 */
export function maskDeviceSid(deviceSid: string | undefined): string {
  if (!deviceSid) return "none";
  return deviceSid.length <= 4 ? deviceSid : `…${deviceSid.slice(-4)}`;
}
