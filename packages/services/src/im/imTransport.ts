import {
  IM_CLOSE_CODES,
  parseImServerFrame,
  type ImClientFrame,
  type ImServerFrame,
} from "@zcode/shared";
import type { ImConnectionStatus } from "./contract.js";

/**
 * WS 连接管理：鉴权（首帧）、心跳、退避重连与状态上报。
 *
 * 它**不碰业务状态**——收到的帧一律交给 onFrame，由 imService 决定怎么落到会话/消息上。
 * 这样连接的健壮性（重连、心跳、终态）能独立于业务被测试。
 *
 * 关闭码语义（与 msgbus src/ws.ts 对齐）：
 * - 4403 forbidden = 不在白名单：**终态**，不再重连（重连也没用，直到 refresh 重新 start）；
 * - 4503 unavailable = 服务端拒绝服务（白名单快照缺失/失配）：慢速重连；
 * - 4401 unauthorized = 令牌问题：重新取令牌后重连。
 */
export interface ImSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

export interface ImTransportOptions {
  resolveUrl: () => Promise<string | undefined>;
  resolveToken: () => Promise<string | undefined>;
  createSocket: (url: string) => ImSocketLike;
  onFrame: (frame: ImServerFrame) => void;
  onStatusChange?: (status: ImConnectionStatus, detail?: { reason?: string }) => void;
  heartbeatMs?: number;
  authTimeoutMs?: number;
  backoffMs?: (attempt: number) => number;
  timers?: {
    set: (callback: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
  now?: () => number;
  log?: (level: "info" | "warn", message: string, detail?: unknown) => void;
}

export interface ImTransport {
  start(): void;
  stop(): void;
  status(): ImConnectionStatus;
  isOnline(): boolean;
  send(frame: ImClientFrame): boolean;
}

const DEFAULTS = { heartbeatMs: 25_000, authTimeoutMs: 8_000 };

export function createImTransport(options: ImTransportOptions): ImTransport {
  const timers = options.timers ?? {
    set: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  };
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs;
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULTS.authTimeoutMs;
  const backoffMs =
    options.backoffMs ?? ((attempt: number) => Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)));

  let socket: ImSocketLike | null = null;
  let status: ImConnectionStatus = "idle";
  let attempt = 0;
  let stopped = true;
  let generation = 0;
  let retryTimer: unknown = null;
  let authTimer: unknown = null;
  let heartbeatTimer: unknown = null;
  let lastPongAt = 0;
  let authenticated = false;

  function setStatus(next: ImConnectionStatus, detail?: { reason?: string }): void {
    if (status === next) return;
    status = next;
    options.onStatusChange?.(next, detail);
  }

  function clearTimer(handle: unknown): void {
    if (handle !== null) timers.clear(handle);
  }

  function teardown(): void {
    clearTimer(retryTimer);
    clearTimer(authTimer);
    clearTimer(heartbeatTimer);
    retryTimer = null;
    authTimer = null;
    heartbeatTimer = null;
    const current = socket;
    socket = null;
    authenticated = false;
    if (current) {
      try {
        current.close(1000, "client teardown");
      } catch {
        // 断开过程中的异常无需上抛
      }
    }
  }

  function scheduleRetry(reason: string): void {
    if (stopped) return;
    const delay = backoffMs(attempt);
    attempt += 1;
    log("info", `IM 连接将在 ${delay}ms 后重试`, { reason, attempt });
    clearTimer(retryTimer);
    retryTimer = timers.set(() => {
      retryTimer = null;
      void connect();
    }, delay);
  }

  /** 装表心跳。注意：**不要在每次 tick 里重置 lastPongAt**，否则"两个周期没 pong"永远不成立、
      半开连接（对端消失但 TCP 还在）永远发现不了。lastPongAt 只在鉴权完成与收到 pong 时更新。 */
  function installHeartbeat(myGeneration: number): void {
    clearTimer(heartbeatTimer);
    heartbeatTimer = timers.set(() => {
      if (myGeneration !== generation || !socket || !authenticated) return;
      if (now() - lastPongAt > heartbeatMs * 2) {
        log("warn", "IM 心跳超时，重建连接");
        setStatus("retrying", { reason: "heartbeat-timeout" });
        teardown();
        if (!stopped) {
          generation += 1;
          scheduleRetry("heartbeat-timeout");
        }
        return;
      }
      try {
        socket.send(JSON.stringify({ type: "ping" } satisfies ImClientFrame));
      } catch (error) {
        log("warn", "IM 发送心跳失败", { message: (error as Error).message });
      }
      installHeartbeat(myGeneration);
    }, heartbeatMs);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const myGeneration = ++generation;
    const url = await options.resolveUrl();
    if (myGeneration !== generation) return;
    if (!url) {
      setStatus("unavailable", { reason: "no-endpoint" });
      scheduleRetry("no-endpoint");
      return;
    }
    const token = await options.resolveToken();
    if (myGeneration !== generation) return;
    if (!token) {
      setStatus("unavailable", { reason: "no-token" });
      scheduleRetry("no-token");
      return;
    }

    setStatus("connecting");
    let next: ImSocketLike;
    try {
      next = options.createSocket(url);
    } catch (error) {
      setStatus("retrying", { reason: "connect-failed" });
      log("warn", "IM 建连失败", { message: (error as Error).message });
      scheduleRetry("connect-failed");
      return;
    }
    socket = next;

    next.addEventListener("open", () => {
      if (myGeneration !== generation) return;
      try {
        next.send(JSON.stringify({ type: "auth", token } satisfies ImClientFrame));
      } catch (error) {
        log("warn", "IM 发送鉴权帧失败", { message: (error as Error).message });
      }
      clearTimer(authTimer);
      authTimer = timers.set(() => {
        if (myGeneration !== generation || authenticated) return;
        log("warn", "IM 鉴权超时，重连");
        teardown();
        if (!stopped) {
          generation += 1;
          scheduleRetry("auth-timeout");
        }
      }, authTimeoutMs);
    });

    next.addEventListener("message", (event: never) => {
      if (myGeneration !== generation) return;
      const data = (event as { data?: unknown }).data;
      const text = typeof data === "string" ? data : "";
      const frame = parseImServerFrame(text);
      if (!frame) {
        log("warn", "IM 收到无法解析的帧，已忽略");
        return;
      }
      if (frame.type === "pong") lastPongAt = now();
      if (frame.type === "ready") {
        clearTimer(authTimer);
        authTimer = null;
        authenticated = true;
        attempt = 0;
        lastPongAt = now();
        setStatus("online");
        installHeartbeat(myGeneration);
      }
      options.onFrame(frame);
    });

    next.addEventListener("close", (event: never) => {
      if (myGeneration !== generation) return;
      const code = (event as { code?: number }).code ?? 1006;
      teardown();
      if (stopped) return;
      if (code === IM_CLOSE_CODES.forbidden) {
        // 终态：不在白名单，重连没有意义；等下一次 refresh() → start() 再试。
        setStatus("forbidden", { reason: "not-in-allowlist" });
        return;
      }
      if (code === IM_CLOSE_CODES.unavailable) {
        setStatus("unavailable", { reason: "server-unavailable" });
        scheduleRetry("server-unavailable");
        return;
      }
      setStatus("retrying", {
        reason: code === IM_CLOSE_CODES.unauthorized ? "unauthorized" : `closed-${code}`,
      });
      scheduleRetry(`closed-${code}`);
    });

    next.addEventListener("error", () => {
      if (myGeneration !== generation) return;
      // error 之后必然有 close（或已被 teardown 处理），这里只记日志避免重复调度。
      log("warn", "IM 连接出错");
    });
  }

  return {
    start(): void {
      stopped = false;
      attempt = 0;
      teardown();
      void connect();
    },
    stop(): void {
      stopped = true;
      generation += 1;
      teardown();
      setStatus("idle");
    },
    status(): ImConnectionStatus {
      return status;
    },
    isOnline(): boolean {
      return status === "online" && authenticated && !!socket;
    },
    send(frame: ImClientFrame): boolean {
      if (!socket || !authenticated) return false;
      try {
        socket.send(JSON.stringify(frame));
        return true;
      } catch (error) {
        log("warn", "IM 发送失败", { message: (error as Error).message });
        return false;
      }
    },
  };
}
