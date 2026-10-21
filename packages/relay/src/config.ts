import { WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS } from "@zcode/shared";

/**
 * 默认值同时是「公网可用」的下限：relay 暴露在公网，不依赖内网可信，
 * 因此限流、房间上限、帧上限、空闲回收都是默认打开的（见 spec 第六节）。
 */
export const RELAY_DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 8787,
  wsPath: "/ws",
  maxConnectionsPerIp: 32,
  registrationsPerMinutePerIp: 30,
  authFailuresPerWindowPerIp: 60,
  authFailureWindowMs: 10 * 60_000,
  maxRooms: 10_000,
  maxFrameBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
  maxBufferedBytes: 4 * 1024 * 1024,
  idleTimeoutMs: 90_000,
  nonceTtlMs: 60_000,
  maxAuthAttempts: 3,
  stateFlushIntervalMs: 1_000,
} as const;

export interface RelayConfig {
  host: string;
  port: number;
  wsPath: string;
  /** 只用于 /health 与日志；容器构建时由 RELAY_VERSION 注入。 */
  version: string;
  /** 落盘文件；不配置则只在内存里保存房间与凭证（重启即失效，仅适合本地调试）。 */
  stateFile?: string;
  /** terminal 的 Origin 允许列表；为空表示不校验（本地调试），公网部署必须配置。 */
  allowedOrigins: string[];
  /** 配置后才启用 /admin/disconnect。 */
  adminToken?: string;
  /**
   * 部署在反代（nginx/网关）后面时打开：按 X-Forwarded-For 第一跳 / X-Real-IP 计算客户端 IP，
   * 否则所有请求都会被算成反代那一个 IP，限流会互相误伤。**只在可信反代后面打开。**
   */
  trustProxyHeaders: boolean;
  maxConnectionsPerIp: number;
  registrationsPerMinutePerIp: number;
  authFailuresPerWindowPerIp: number;
  authFailureWindowMs: number;
  maxRooms: number;
  maxFrameBytes: number;
  maxBufferedBytes: number;
  idleTimeoutMs: number;
  /** 空闲检查周期；不配则按 idleTimeoutMs/6（下限 1s）推导。 */
  idleSweepIntervalMs?: number;
  nonceTtlMs: number;
  maxAuthAttempts: number;
  stateFlushIntervalMs: number;
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数，收到 ${raw}`);
  }
  return value;
}

function readString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  return raw ? raw : fallback;
}

function readList(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = env[name]?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function readRelayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const allowedOrigins = readList(env, "RELAY_ALLOWED_ORIGINS");
  const stateFile = env["RELAY_STATE_FILE"]?.trim();
  const adminToken = env["RELAY_ADMIN_TOKEN"]?.trim();
  return {
    host: readString(env, "RELAY_HOST", RELAY_DEFAULT_CONFIG.host),
    port: readInt(env, "RELAY_PORT", RELAY_DEFAULT_CONFIG.port),
    wsPath: readString(env, "RELAY_WS_PATH", RELAY_DEFAULT_CONFIG.wsPath),
    version: readString(env, "RELAY_VERSION", "dev"),
    ...(stateFile ? { stateFile } : {}),
    allowedOrigins,
    ...(adminToken ? { adminToken } : {}),
    trustProxyHeaders: env["RELAY_TRUST_PROXY_HEADERS"]?.trim() === "true",
    maxConnectionsPerIp: readInt(
      env,
      "RELAY_MAX_CONNECTIONS_PER_IP",
      RELAY_DEFAULT_CONFIG.maxConnectionsPerIp,
    ),
    registrationsPerMinutePerIp: readInt(
      env,
      "RELAY_REGISTRATIONS_PER_MINUTE_PER_IP",
      RELAY_DEFAULT_CONFIG.registrationsPerMinutePerIp,
    ),
    authFailuresPerWindowPerIp: readInt(
      env,
      "RELAY_AUTH_FAILURES_PER_WINDOW_PER_IP",
      RELAY_DEFAULT_CONFIG.authFailuresPerWindowPerIp,
    ),
    authFailureWindowMs: readInt(
      env,
      "RELAY_AUTH_FAILURE_WINDOW_MS",
      RELAY_DEFAULT_CONFIG.authFailureWindowMs,
    ),
    maxRooms: readInt(env, "RELAY_MAX_ROOMS", RELAY_DEFAULT_CONFIG.maxRooms),
    maxFrameBytes: readInt(env, "RELAY_MAX_FRAME_BYTES", RELAY_DEFAULT_CONFIG.maxFrameBytes),
    maxBufferedBytes: readInt(
      env,
      "RELAY_MAX_BUFFERED_BYTES",
      RELAY_DEFAULT_CONFIG.maxBufferedBytes,
    ),
    idleTimeoutMs: readInt(env, "RELAY_IDLE_TIMEOUT_MS", RELAY_DEFAULT_CONFIG.idleTimeoutMs),
    ...(env["RELAY_IDLE_SWEEP_INTERVAL_MS"]?.trim()
      ? { idleSweepIntervalMs: readInt(env, "RELAY_IDLE_SWEEP_INTERVAL_MS", 1_000) }
      : {}),
    nonceTtlMs: readInt(env, "RELAY_NONCE_TTL_MS", RELAY_DEFAULT_CONFIG.nonceTtlMs),
    maxAuthAttempts: readInt(env, "RELAY_MAX_AUTH_ATTEMPTS", RELAY_DEFAULT_CONFIG.maxAuthAttempts),
    stateFlushIntervalMs: readInt(
      env,
      "RELAY_STATE_FLUSH_INTERVAL_MS",
      RELAY_DEFAULT_CONFIG.stateFlushIntervalMs,
    ),
  };
}

export function createRelayConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return { ...readRelayConfigFromEnv({}), ...overrides };
}
