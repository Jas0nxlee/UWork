import type { WebRemoteControlRelayDeviceMeta, WebRemoteControlRelayRole } from "@zcode/shared";
import { createRelayAuthNonce, verifyRelayAuthProof } from "./auth.js";
import { maskDeviceSid, type RelayLogger } from "./logging.js";
import type { RelayPeer } from "./peer.js";
import { RelayRoomRegistry } from "./rooms.js";
import type { RelayDeviceStore } from "./store.js";

interface PendingAuth {
  deviceSid: string;
  role: WebRemoteControlRelayRole;
  nonce: string;
  expiresAt: number;
  attempts: number;
}

export interface RelayHubOptions {
  store: RelayDeviceStore;
  logger: RelayLogger;
  nonceTtlMs: number;
  maxAuthAttempts: number;
  maxRooms: number;
  now?: () => number;
}

/**
 * 协议编排：注册 → 配对鉴权 → 配对状态 → 透传。
 * 行为契约见 specs/web-remote-control-relay.md 第二~五节；这里不碰 socket 细节。
 */
export class RelayHub {
  private readonly store: RelayDeviceStore;
  private readonly logger: RelayLogger;
  private readonly rooms = new RelayRoomRegistry();
  private readonly peers = new Map<string, RelayPeer>();
  private readonly pending = new Map<string, PendingAuth>();
  private readonly nonceTtlMs: number;
  private readonly maxAuthAttempts: number;
  private readonly maxRooms: number;
  private readonly now: () => number;

  constructor(options: RelayHubOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.nonceTtlMs = options.nonceTtlMs;
    this.maxAuthAttempts = options.maxAuthAttempts;
    this.maxRooms = options.maxRooms;
    this.now = options.now ?? Date.now;
  }

  addPeer(peer: RelayPeer): void {
    this.peers.set(peer.connectionId, peer);
  }

  registerDevice(
    peer: RelayPeer,
    params: {
      deviceMid: string;
      passHash: string;
      meta: WebRemoteControlRelayDeviceMeta;
    },
  ): void {
    if (peer.role()) {
      this.logger.warn("device_register_init on authenticated connection ignored", {
        role: peer.role(),
      });
      return;
    }
    if (this.store.size() >= this.maxRooms) {
      // 容量拒绝用 AUTH_FAILED：桌面会当作终态错误而不是无限重试（spec 第六节）。
      peer.reject("AUTH_FAILED", "relay-capacity");
      this.logger.warn("device registration rejected: capacity", { rooms: this.store.size() });
      return;
    }
    const record = this.store.register(params);
    this.logger.info("device registered", {
      sid: maskDeviceSid(record.deviceSid),
      mid: record.deviceMid,
      platform: record.meta.platform,
    });
    peer.send({ type: "device_register_ack", device_sid: record.deviceSid, server_ts: this.now() });
  }

  startAuth(
    peer: RelayPeer,
    params: {
      role: WebRemoteControlRelayRole;
      deviceSid: string;
      meta: WebRemoteControlRelayDeviceMeta;
    },
  ): void {
    if (peer.role()) {
      // 重复握手不降级已鉴权连接：否则一次乱序 auth_init 就能把配好的会话踢成未鉴权。
      this.logger.warn("auth_init on authenticated connection ignored", {
        role: peer.role(),
        sid: maskDeviceSid(peer.deviceSid()),
      });
      return;
    }
    const record = this.store.get(params.deviceSid);
    if (!record) {
      this.rejectUnknownDeviceSid(peer, params.role, params.deviceSid);
      return;
    }
    const pending: PendingAuth = {
      deviceSid: params.deviceSid,
      role: params.role,
      nonce: createRelayAuthNonce(),
      expiresAt: this.now() + this.nonceTtlMs,
      attempts: 0,
    };
    this.pending.set(peer.connectionId, pending);
    peer.send({ type: "auth_challenge", nonce: pending.nonce, server_ts: this.now() });
  }

  completeAuth(peer: RelayPeer, params: { deviceSid: string; proof: string }): void {
    const pending = this.pending.get(peer.connectionId);
    if (!pending) {
      peer.reject("WRONG_PARAM", "auth_response-before-auth_init");
      return;
    }
    if (pending.deviceSid !== params.deviceSid) {
      peer.reject("WRONG_PARAM", "auth_response-sid-mismatch");
      return;
    }
    if (pending.expiresAt <= this.now()) {
      this.pending.delete(peer.connectionId);
      peer.reject("AUTH_FAILED", "auth-nonce-expired");
      return;
    }
    pending.attempts += 1;
    if (pending.attempts > this.maxAuthAttempts) {
      this.pending.delete(peer.connectionId);
      peer.reject("AUTH_FAILED", "too-many-auth-attempts");
      return;
    }
    const record = this.store.get(pending.deviceSid);
    if (!record) {
      this.pending.delete(peer.connectionId);
      this.rejectUnknownDeviceSid(peer, pending.role, pending.deviceSid);
      return;
    }
    const verified = verifyRelayAuthProof({
      passHash: record.passHash,
      nonce: pending.nonce,
      role: pending.role,
      deviceSid: pending.deviceSid,
      proof: params.proof,
    });
    if (!verified) {
      // nonce 一次性：失败即作废，必须重新 auth_init。
      this.pending.delete(peer.connectionId);
      peer.reject("AUTH_FAILED", "auth-proof-invalid");
      this.logger.warn("auth proof rejected", {
        sid: maskDeviceSid(pending.deviceSid),
        role: pending.role,
      });
      return;
    }

    this.pending.delete(peer.connectionId);
    const { role, deviceSid } = pending;
    peer.commitAuth(role, deviceSid);
    this.store.touch(deviceSid);
    const { displacedConnectionId } = this.rooms.occupy(deviceSid, role, peer.connectionId);
    if (displacedConnectionId) {
      // 同角色只允许一个连接：新连接顶掉旧的（第二个手机 / 桌面重连后的旧 socket）。
      const displaced = this.peers.get(displacedConnectionId);
      displaced?.reject("KICKED", `replaced-by-newer-${role}`);
      this.logger.info("connection replaced", { sid: maskDeviceSid(deviceSid), role });
    }

    const pairStatus = this.rooms.status(deviceSid);
    peer.send({
      type: "auth_ack",
      device_sid: deviceSid,
      ...(pairStatus === "matched"
        ? { terminal_sid: this.rooms.peerConnectionId(deviceSid, "terminal") }
        : {}),
      pair_status: pairStatus,
      server_ts: this.now(),
    });
    this.logger.info("auth granted", { sid: maskDeviceSid(deviceSid), role, pairStatus });
    this.broadcastPairStatus(deviceSid, peer.connectionId);

    if (role === "terminal" && this.rooms.peerConnectionId(deviceSid, "device") === undefined) {
      // 桌面此刻不在线：手机需要 DEVICE_OFFLINE 才会走「电脑端离线」宽限，而不是 waiting 超时的
      // invalid-mobile-connection（spec 第四节）。
      peer.notify("DEVICE_OFFLINE", "device-offline");
    }
  }

  handlePairStatusQuery(peer: RelayPeer, requestedDeviceSid: string): void {
    const deviceSid = peer.deviceSid();
    if (!deviceSid || !peer.role()) {
      peer.reject("WRONG_PARAM", "pair_status_query-before-auth");
      return;
    }
    if (deviceSid !== requestedDeviceSid) {
      // 已鉴权连接只能问自己的房间：按自己的 sid 回答而不是回 WRONG_PARAM，
      // 否则一次参数错误会让手机端直接进终态失败页。
      this.logger.warn("pair_status_query sid mismatch", {
        sid: maskDeviceSid(deviceSid),
        requested: maskDeviceSid(requestedDeviceSid),
      });
    }
    this.store.touch(deviceSid);
    peer.send(this.pairStatusMessage(deviceSid));
  }

  handleData(peer: RelayPeer, payload: unknown): void {
    const deviceSid = peer.deviceSid();
    const role = peer.role();
    if (!deviceSid || !role) {
      peer.reject("WRONG_PARAM", "data-before-auth");
      return;
    }
    const peerConnectionId = this.rooms.peerConnectionId(
      deviceSid,
      role === "device" ? "terminal" : "device",
    );
    const target = peerConnectionId ? this.peers.get(peerConnectionId) : undefined;
    if (!target) {
      // 投递不到就回 INTERNAL 且不断连：两侧客户端都把它当可恢复信号（spec 第五节）。
      peer.notify("INTERNAL", "no-paired-peer");
      return;
    }
    target.send({ type: "data", payload, server_ts: this.now() });
  }

  detach(peer: RelayPeer): void {
    this.pending.delete(peer.connectionId);
    this.peers.delete(peer.connectionId);
    const release = this.rooms.release(peer.connectionId);
    if (!release) return;
    if (release.role === "device" && release.peerConnectionId) {
      const terminal = this.peers.get(release.peerConnectionId);
      terminal?.notify("DEVICE_OFFLINE", "device-disconnected");
      this.logger.info("device left, terminal notified", { sid: maskDeviceSid(release.deviceSid) });
    }
    this.broadcastPairStatus(release.deviceSid, peer.connectionId);
  }

  /** 运维动作：按 sid 断开两端。桌面会因 AUTH_FAILED 重新注册新 sid，旧链接随之失效。 */
  forceDisconnect(deviceSid: string): number {
    const connectionIds = this.rooms.removeAll(deviceSid);
    for (const connectionId of connectionIds) {
      const peer = this.peers.get(connectionId);
      peer?.reject("AUTH_FAILED", "disconnected-by-admin");
    }
    return connectionIds.length;
  }

  stats(): { rooms: number; paired: number; connections: number } {
    const { rooms, paired } = this.rooms.sizes();
    return { rooms, paired, connections: this.peers.size };
  }

  private rejectUnknownDeviceSid(
    peer: RelayPeer,
    role: WebRemoteControlRelayRole,
    deviceSid: string,
  ): void {
    if (role === "device") {
      peer.reject("AUTH_FAILED", "unknown-device-sid");
    } else {
      peer.notify("DEVICE_OFFLINE", "unknown-device-sid");
    }
    this.logger.info("auth_init rejected", { sid: maskDeviceSid(deviceSid), role });
  }

  private pairStatusMessage(deviceSid: string) {
    const pairStatus = this.rooms.status(deviceSid);
    const terminalSid = this.rooms.peerConnectionId(deviceSid, "terminal");
    return {
      type: "pair_status_ack" as const,
      ...(terminalSid ? { terminal_sid: terminalSid } : {}),
      pair_status: pairStatus,
      server_ts: this.now(),
    };
  }

  private broadcastPairStatus(deviceSid: string, excludeConnectionId: string): void {
    const message = this.pairStatusMessage(deviceSid);
    for (const role of ["device", "terminal"] as const) {
      const connectionId = this.rooms.peerConnectionId(deviceSid, role);
      if (!connectionId || connectionId === excludeConnectionId) continue;
      this.peers.get(connectionId)?.send(message);
    }
  }
}
