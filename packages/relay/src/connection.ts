import type { WebRemoteControlRelayErrorCode, WebRemoteControlRelayRole } from "@zcode/shared";
import type { WebSocket } from "ws";
import type { RelayHub } from "./hub.js";
import { maskDeviceSid, type RelayLogger } from "./logging.js";
import type { RelayOutgoingMessage, RelayPeer } from "./peer.js";
import { parseRelayClientMessage } from "./protocol.js";

const POLICY_VIOLATION = 1008;
const GOING_AWAY = 1001;

export interface RelayConnectionOptions {
  connectionId: string;
  socket: WebSocket;
  hub: RelayHub;
  logger: RelayLogger;
  remoteAddress: string;
  maxFrameBytes: number;
  maxBufferedBytes: number;
  idleTimeoutMs: number;
  idleSweepIntervalMs?: number;
  /** 每 IP 注册速率闸；返回 false 时拒绝这次 device_register_init。 */
  admitRegistration?: (remoteAddress: string) => boolean;
  /** 鉴权失败回执：供服务端做每 IP 爆破计数。 */
  onAuthRejected?: (remoteAddress: string) => void;
  now?: () => number;
}

function measureMessageBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) {
    let total = 0;
    for (const chunk of data) total += measureMessageBytes(chunk);
    return total;
  }
  if (data instanceof ArrayBuffer) return data.byteLength;
  return 0;
}

/**
 * 一条 WS 连接的传输层：帧上限、发送缓冲、空闲回收、错误分级，
 * 协议语义全部交给 hub（spec 第二~五节）。
 */
export class RelayConnection implements RelayPeer {
  readonly connectionId: string;
  readonly remoteAddress: string;
  private readonly socket: WebSocket;
  private readonly hub: RelayHub;
  private readonly logger: RelayLogger;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly admitRegistration?: (remoteAddress: string) => boolean;
  private readonly onAuthRejected?: (remoteAddress: string) => void;
  private readonly idleTimer: NodeJS.Timeout;
  private authenticatedRole: WebRemoteControlRelayRole | null = null;
  private authenticatedDeviceSid?: string;
  private lastInboundAt: number;
  private closed = false;
  private droppedOutbound = 0;

  constructor(options: RelayConnectionOptions) {
    this.connectionId = options.connectionId;
    this.remoteAddress = options.remoteAddress;
    this.socket = options.socket;
    this.hub = options.hub;
    this.logger = options.logger;
    this.maxFrameBytes = options.maxFrameBytes;
    this.maxBufferedBytes = options.maxBufferedBytes;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.now = options.now ?? Date.now;
    this.admitRegistration = options.admitRegistration;
    this.onAuthRejected = options.onAuthRejected;
    this.lastInboundAt = this.now();

    this.socket.on("message", (data) => this.handleRawMessage(data));
    this.socket.on("close", () => this.handleClose());
    this.socket.on("error", (error) => {
      this.logger.warn("connection socket error", { message: error.message });
    });

    this.idleTimer = setInterval(
      () => this.sweepIdle(),
      options.idleSweepIntervalMs ?? Math.max(1_000, Math.floor(this.idleTimeoutMs / 6)),
    );
    this.idleTimer.unref?.();
    this.hub.addPeer(this);
  }

  role(): WebRemoteControlRelayRole | null {
    return this.authenticatedRole;
  }

  deviceSid(): string | undefined {
    return this.authenticatedDeviceSid;
  }

  commitAuth(role: WebRemoteControlRelayRole, deviceSid: string): void {
    this.authenticatedRole = role;
    this.authenticatedDeviceSid = deviceSid;
  }

  send(message: RelayOutgoingMessage): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    if (this.socket.bufferedAmount > this.maxBufferedBytes) {
      // 背压保护：丢弃而不是无限排队（spec 第六节）。客户端有自己的 ACK 与重试。
      this.droppedOutbound += 1;
      this.logger.warn("outbound message dropped: buffer limit", {
        sid: maskDeviceSid(this.authenticatedDeviceSid),
        buffered: this.socket.bufferedAmount,
        dropped: this.droppedOutbound,
      });
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  notify(code: WebRemoteControlRelayErrorCode, message: string): void {
    this.send({ type: "error", code, message, server_ts: this.now() });
  }

  reject(code: WebRemoteControlRelayErrorCode, message: string): void {
    if (code === "AUTH_FAILED") {
      this.onAuthRejected?.(this.remoteAddress);
    }
    this.notify(code, message);
    this.closeWith(POLICY_VIOLATION, code);
  }

  /** 用于优雅退出：不发送 error，直接 going away。 */
  closeWith(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  dispose(): void {
    clearInterval(this.idleTimer);
    this.hub.detach(this);
  }

  private handleRawMessage(data: unknown): void {
    const bytes = measureMessageBytes(data);
    this.lastInboundAt = this.now();
    if (bytes > this.maxFrameBytes) {
      this.logger.warn("inbound frame dropped: over limit", {
        bytes,
        maxFrameBytes: this.maxFrameBytes,
        sid: maskDeviceSid(this.authenticatedDeviceSid),
      });
      this.notify("INTERNAL", "frame-over-limit");
      return;
    }
    const text =
      typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : null;
    if (text === null) {
      this.notify("INTERNAL", "unsupported-frame");
      return;
    }
    const message = parseRelayClientMessage(text);
    if (message.kind === "invalid") {
      if (!this.authenticatedRole) {
        this.reject("WRONG_PARAM", message.reason);
        return;
      }
      // 已鉴权连接不因为一帧坏数据被拆掉；客户端各自有恢复逻辑。
      this.logger.warn("invalid message on authenticated connection dropped", {
        reason: message.reason,
        sid: maskDeviceSid(this.authenticatedDeviceSid),
      });
      return;
    }

    switch (message.kind) {
      case "device_register_init":
        if (this.admitRegistration && !this.admitRegistration(this.remoteAddress)) {
          this.reject("AUTH_FAILED", "registration-rate-limited");
          return;
        }
        this.hub.registerDevice(this, {
          deviceMid: message.deviceMid,
          passHash: message.passHash,
          meta: message.meta,
        });
        return;
      case "auth_init":
        this.hub.startAuth(this, {
          role: message.role,
          deviceSid: message.deviceSid,
          meta: message.meta,
        });
        return;
      case "auth_response":
        this.hub.completeAuth(this, { deviceSid: message.deviceSid, proof: message.proof });
        return;
      case "pair_status_query":
        this.hub.handlePairStatusQuery(this, message.deviceSid);
        return;
      case "data":
        this.hub.handleData(this, message.payload);
        return;
    }
  }

  private handleClose(): void {
    if (this.closed) {
      this.dispose();
      return;
    }
    this.closed = true;
    this.dispose();
  }

  private sweepIdle(): void {
    if (this.closed) return;
    if (this.now() - this.lastInboundAt < this.idleTimeoutMs) return;
    // 只在完全没有上行流量时回收：等扫码的桌面每 10s 有心跳，不会被误杀。
    this.logger.info("connection reclaimed: idle", {
      sid: maskDeviceSid(this.authenticatedDeviceSid),
      role: this.authenticatedRole ?? "none",
      idleMs: this.now() - this.lastInboundAt,
    });
    this.closeWith(GOING_AWAY, "idle");
  }
}
