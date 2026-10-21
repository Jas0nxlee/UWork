import { createRelayServer, type RelayConfig, type RelayServer } from "./contract.js";

export interface RelayExample {
  server: RelayServer;
  wsUrl: string;
  httpUrl: string;
  close(): Promise<void>;
}

/**
 * 最小可用示例：起一个 relay（内存态鉴权、随机端口），拿到手机页要连的 ws 地址。
 * 真实部署见 spec 第八节：容器 + 同域 nginx 反代 + 落盘 stateFile。
 */
export async function startExampleRelay(
  overrides: Partial<RelayConfig> = {},
): Promise<RelayExample> {
  const server = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    wsPath: "/ws",
    version: "example",
    allowedOrigins: [],
    trustProxyHeaders: false,
    maxConnectionsPerIp: 8,
    registrationsPerMinutePerIp: 8,
    authFailuresPerWindowPerIp: 16,
    authFailureWindowMs: 600_000,
    maxRooms: 32,
    maxFrameBytes: 1024 * 1024,
    maxBufferedBytes: 4 * 1024 * 1024,
    idleTimeoutMs: 90_000,
    nonceTtlMs: 60_000,
    maxAuthAttempts: 3,
    stateFlushIntervalMs: 1_000,
    ...overrides,
  });
  const { port } = await server.listen();
  return {
    server,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    httpUrl: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}
