import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayConnection } from "./connection.js";
import type { RelayConfig } from "./config.js";
import { RelayHub } from "./hub.js";
import { createRelayLogger, type RelayLogger } from "./logging.js";
import { RelayRateLimiter } from "./rates.js";
import { RelayDeviceStore } from "./store.js";

const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const TOO_MANY_REQUESTS = 429;
const BAD_REQUEST = 400;

export interface RelayHealth {
  status: "ok";
  version: string;
  uptimeMs: number;
  rooms: number;
  paired: number;
  connections: number;
  devices: number;
}

export interface RelayServer {
  readonly hub: RelayHub;
  readonly store: RelayDeviceStore;
  readonly httpPort: number;
  health(): RelayHealth;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

function readHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/**
 * 反代后面拿客户端 IP：优先 X-Forwarded-For 第一跳（网关会 $proxy_add_x_forwarded_for 追加），
 * 退回 X-Real-IP，最后才是 socket 地址。仅在 trustProxyHeaders 打开时使用——否则这些头
 * 是客户端可控的，限流会被伪造绕过。
 */
function resolveClientAddress(request: IncomingMessage, trustProxyHeaders: boolean): string {
  if (trustProxyHeaders) {
    const forwardedFor = readHeader(request, "x-forwarded-for");
    const firstHop = forwardedFor?.split(",")[0]?.trim();
    if (firstHop) return firstHop;
    const realIp = readHeader(request, "x-real-ip")?.trim();
    if (realIp) return realIp;
  }
  return request.socket.remoteAddress ?? "unknown";
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 16 * 1024) {
      throw new Error("request body too large");
    }
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const decoded: unknown = JSON.parse(text);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("request body must be a JSON object");
  }
  return decoded as Record<string, unknown>;
}

function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) return true;
  // 桌面端（Node ws）不发 Origin；只校验浏览器侧（手机页 terminal）。
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

export function createRelayServer(
  config: RelayConfig,
  deps: { logger?: RelayLogger } = {},
): RelayServer {
  const logger = deps.logger ?? createRelayLogger();
  const store = new RelayDeviceStore({
    ...(config.stateFile ? { stateFile: config.stateFile } : {}),
    flushIntervalMs: config.stateFlushIntervalMs,
    logger,
  });
  store.loadSync();
  const hub = new RelayHub({
    store,
    logger,
    nonceTtlMs: config.nonceTtlMs,
    maxAuthAttempts: config.maxAuthAttempts,
    maxRooms: config.maxRooms,
  });
  const limiter = new RelayRateLimiter({
    maxConnectionsPerIp: config.maxConnectionsPerIp,
    registrationsPerMinutePerIp: config.registrationsPerMinutePerIp,
    authFailuresPerWindowPerIp: config.authFailuresPerWindowPerIp,
    authFailureWindowMs: config.authFailureWindowMs,
  });
  const connections = new Set<RelayConnection>();
  const startedAt = Date.now();

  const health = (): RelayHealth => {
    const stats = hub.stats();
    return {
      status: "ok",
      version: config.version,
      uptimeMs: Date.now() - startedAt,
      rooms: stats.rooms,
      paired: stats.paired,
      connections: stats.connections,
      devices: store.size(),
    };
  };

  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      respondJson(response, 200, health());
      return;
    }
    if (url.pathname === "/admin/disconnect") {
      if (!config.adminToken) {
        respondJson(response, NOT_FOUND, { error: "admin-disabled" });
        return;
      }
      if (request.method !== "POST") {
        respondJson(response, BAD_REQUEST, { error: "method-not-allowed" });
        return;
      }
      if (readHeader(request, "authorization") !== `Bearer ${config.adminToken}`) {
        respondJson(response, UNAUTHORIZED, { error: "unauthorized" });
        return;
      }
      void readJsonBody(request)
        .then((body) => {
          const deviceSid = typeof body["deviceSid"] === "string" ? body["deviceSid"] : "";
          if (!deviceSid) {
            respondJson(response, BAD_REQUEST, { error: "deviceSid-required" });
            return;
          }
          const disconnected = hub.forceDisconnect(deviceSid);
          logger.info("admin disconnect", { sid: deviceSid.slice(-4), disconnected });
          respondJson(response, 200, { disconnected });
        })
        .catch((error: unknown) => {
          respondJson(response, BAD_REQUEST, { error: (error as Error).message });
        });
      return;
    }
    respondJson(response, NOT_FOUND, { error: "not-found" });
  });

  const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== config.wsPath) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!isOriginAllowed(readHeader(request, "origin"), config.allowedOrigins)) {
      logger.warn("upgrade rejected: origin not allowed", {
        origin: readHeader(request, "origin"),
      });
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const remoteAddress = resolveClientAddress(request, config.trustProxyHeaders);
    const admitted = limiter.admitConnection(remoteAddress);
    if (!admitted.ok) {
      logger.warn("upgrade rejected: rate limited", { reason: admitted.reason });
      socket.write(`HTTP/1.1 ${TOO_MANY_REQUESTS} Too Many Requests\r\n\r\n`);
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      acceptWebSocket(ws, remoteAddress);
    });
  });

  wsServer.on("connection", (socket: WebSocket) => {
    socket.on("error", () => {});
  });

  function acceptWebSocket(socket: WebSocket, remoteAddress: string): void {
    const connection = new RelayConnection({
      connectionId: randomUUID(),
      socket,
      hub,
      logger,
      remoteAddress,
      maxFrameBytes: config.maxFrameBytes,
      maxBufferedBytes: config.maxBufferedBytes,
      idleTimeoutMs: config.idleTimeoutMs,
      ...(config.idleSweepIntervalMs ? { idleSweepIntervalMs: config.idleSweepIntervalMs } : {}),
      admitRegistration: (address) => limiter.admitRegistration(address),
      onAuthRejected: (address) => limiter.recordAuthFailure(address),
    });
    connections.add(connection);
    socket.on("close", () => {
      connections.delete(connection);
      limiter.releaseConnection(remoteAddress);
    });
  }

  return {
    hub,
    store,
    get httpPort(): number {
      const address = httpServer.address() as AddressInfo | null;
      return address?.port ?? 0;
    },
    health,
    listen(): Promise<{ host: string; port: number }> {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(config.port, config.host, () => {
          httpServer.removeListener("error", reject);
          const address = httpServer.address() as AddressInfo | null;
          resolve({ host: config.host, port: address?.port ?? config.port });
        });
      });
    },
    async close(): Promise<void> {
      for (const connection of connections) {
        connection.closeWith(1001, "server-shutdown");
      }
      for (const socket of wsServer.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        wsServer.close(() => resolve());
        httpServer.close(() => resolve());
      });
      await store.close();
    },
  };
}
