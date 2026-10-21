import { WebSocket } from "ws";
import type {
  WebRemoteControlRelayDeviceMeta,
  WebRemoteControlRelayError,
  WebRemoteControlRelayIncomingMessage,
  WebRemoteControlRelayRole,
} from "@zcode/shared";
import { calculateRelayAuthProof } from "../../src/auth.js";
import { createRelayConfig, type RelayConfig } from "../../src/config.js";
import { createSilentRelayLogger } from "../../src/logging.js";
import { createRelayServer } from "../../src/server.js";

export const DEVICE_META: WebRemoteControlRelayDeviceMeta = {
  platform: "darwin",
  version: "test",
  name: "desktop",
};
export const TERMINAL_META: WebRemoteControlRelayDeviceMeta = {
  platform: "web",
  version: "test",
  name: "mobile-browser",
};

export interface RelayTestServer {
  url: string;
  port: number;
  config: RelayConfig;
  server: ReturnType<typeof createRelayServer>;
  close(): Promise<void>;
}

export async function startRelay(overrides: Partial<RelayConfig> = {}): Promise<RelayTestServer> {
  const config = createRelayConfig({ host: "127.0.0.1", port: 0, ...overrides });
  const server = createRelayServer(config, { logger: createSilentRelayLogger() });
  const { port } = await server.listen();
  return {
    url: `ws://127.0.0.1:${port}${config.wsPath}`,
    port,
    config,
    server,
    close: () => server.close(),
  };
}

export interface RelayTestClient {
  socket: WebSocket;
  received: WebRemoteControlRelayIncomingMessage[];
  errors: WebRemoteControlRelayError[];
  closeInfo?: { code: number; reason: string };
  closed: Promise<{ code: number; reason: string }>;
  send(message: unknown): void;
  /**
   * 取一条满足谓词的消息。T 故意不加 union 约束：relay 侧 payload 是 unknown，
   * 而 shared 的 data 成员按业务载荷参数化，用例直接声明自己期待的形状即可。
   */
  waitFor<T = WebRemoteControlRelayIncomingMessage>(
    predicate: (message: WebRemoteControlRelayIncomingMessage) => boolean,
    timeoutMs?: number,
  ): Promise<T>;
  waitForErrorCode(code: string, timeoutMs?: number): Promise<WebRemoteControlRelayError>;
  close(): void;
}

export interface ConnectOptions {
  query?: string;
  origin?: string;
  headers?: Record<string, string>;
}

export async function connectClient(
  relay: RelayTestServer,
  options: ConnectOptions = {},
): Promise<RelayTestClient> {
  const url = options.query ? `${relay.url}?${options.query}` : relay.url;
  const socket = new WebSocket(url, {
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  const received: WebRemoteControlRelayIncomingMessage[] = [];
  const errors: WebRemoteControlRelayError[] = [];
  let closeInfo: { code: number; reason: string } | undefined;
  const waiters: Array<{
    predicate: (message: WebRemoteControlRelayIncomingMessage) => boolean;
    resolve: (message: WebRemoteControlRelayIncomingMessage) => void;
    timer: NodeJS.Timeout;
  }> = [];

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.on("close", (code, reason) => {
      closeInfo = { code, reason: reason.toString() };
      resolve(closeInfo);
    });
  });

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8")) as WebRemoteControlRelayIncomingMessage;
    received.push(message);
    if (message.type === "error") {
      errors.push(message as WebRemoteControlRelayError);
    }
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });

  function waitFor<T = WebRemoteControlRelayIncomingMessage>(
    predicate: (message: WebRemoteControlRelayIncomingMessage) => boolean,
    timeoutMs = 3_000,
  ): Promise<T> {
    const existing = received.find(predicate);
    if (existing) return Promise.resolve(existing as T);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.splice(
          waiters.findIndex((waiter) => waiter.timer === timer),
          1,
        );
        reject(
          new Error(
            `等待消息超时；已收到 ${received.map((message) => message.type).join(",") || "（无）"}`,
          ),
        );
      }, timeoutMs);
      waiters.push({
        predicate,
        resolve: (message) => resolve(message as T),
        timer,
      });
    });
  }

  return {
    socket,
    received,
    errors,
    get closeInfo() {
      return closeInfo;
    },
    closed,
    send: (message) => socket.send(JSON.stringify(message)),
    waitFor,
    waitForErrorCode: (code, timeoutMs) =>
      waitFor<WebRemoteControlRelayError>(
        (message) => message.type === "error" && message.code === code,
        timeoutMs,
      ),
    close: () => socket.close(),
  };
}

export function proof(
  passHash: string,
  nonce: string,
  role: WebRemoteControlRelayRole,
  deviceSid: string,
): string {
  return calculateRelayAuthProof({ passHash, nonce, role, deviceSid });
}

export interface AuthenticatedPair {
  device: RelayTestClient;
  terminal: RelayTestClient;
  deviceSid: string;
  passHash: string;
}

export async function registerDevice(
  relay: RelayTestServer,
  params: { deviceMid?: string; passHash?: string; meta?: WebRemoteControlRelayDeviceMeta } = {},
): Promise<{ client: RelayTestClient; deviceSid: string; passHash: string }> {
  const passHash = params.passHash ?? "dGVzdF9oYXNo";
  const deviceMid = params.deviceMid ?? "device-mid-1";
  const client = await connectClient(relay, { query: `mid=${deviceMid}` });
  client.send({
    type: "device_register_init",
    device_mid: deviceMid,
    pass_hash: passHash,
    meta: params.meta ?? DEVICE_META,
  });
  const ack = await client.waitFor<{ type: "device_register_ack"; device_sid: string }>(
    (message) => message.type === "device_register_ack",
  );
  return { client, deviceSid: ack.device_sid, passHash };
}

export async function authenticate(
  client: RelayTestClient,
  params: {
    role: WebRemoteControlRelayRole;
    deviceSid: string;
    passHash: string;
    meta?: WebRemoteControlRelayDeviceMeta;
  },
): Promise<void> {
  client.send({
    type: "auth_init",
    role: params.role,
    device_sid: params.deviceSid,
    meta: params.meta ?? (params.role === "device" ? DEVICE_META : TERMINAL_META),
  });
  const challenge = await client.waitFor<{ type: "auth_challenge"; nonce: string }>(
    (message) => message.type === "auth_challenge",
  );
  client.send({
    type: "auth_response",
    device_sid: params.deviceSid,
    proof: proof(params.passHash, challenge.nonce, params.role, params.deviceSid),
  });
}

/** 注册 + 双侧鉴权到 matched：绝大多数用例的起手式。 */
export async function pairDeviceAndTerminal(relay: RelayTestServer): Promise<AuthenticatedPair> {
  const { client: device, deviceSid, passHash } = await registerDevice(relay);
  await authenticate(device, { role: "device", deviceSid, passHash });
  const terminal = await connectClient(relay, { query: "mid=device-mid-1" });
  await authenticate(terminal, { role: "terminal", deviceSid, passHash });
  await device.waitFor(
    (message) => message.type === "pair_status_ack" && message.pair_status === "matched",
  );
  return { device, terminal, deviceSid, passHash };
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitUntil 超时");
}
