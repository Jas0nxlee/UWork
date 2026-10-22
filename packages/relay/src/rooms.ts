import type { WebRemoteControlRelayPairStatus, WebRemoteControlRelayRole } from "@zcode/shared";

interface RelayRoomOccupancy {
  deviceConnectionId?: string;
  terminalConnectionId?: string;
}

export interface RelayRoomRelease {
  deviceSid: string;
  role: WebRemoteControlRelayRole;
  /** 释放后仍留在房间里的对端连接；没有就是 undefined。 */
  peerConnectionId?: string;
}

function slotKey(role: WebRemoteControlRelayRole): keyof RelayRoomOccupancy {
  return role === "device" ? "deviceConnectionId" : "terminalConnectionId";
}

/**
 * 房间 = device_sid，两个槽位：device（桌面）与 terminal（手机）。
 * 这里只管占位与状态推导，不认识 socket、不发送消息（发送在 hub）。
 */
export class RelayRoomRegistry {
  private readonly rooms = new Map<string, RelayRoomOccupancy>();
  private readonly byConnection = new Map<
    string,
    { deviceSid: string; role: WebRemoteControlRelayRole }
  >();

  /** 同角色新连接顶掉旧连接时返回被顶替者的 connectionId（调用方负责发 KICKED）。 */
  occupy(
    deviceSid: string,
    role: WebRemoteControlRelayRole,
    connectionId: string,
  ): { displacedConnectionId?: string } {
    const occupancy = this.rooms.get(deviceSid) ?? {};
    this.rooms.set(deviceSid, occupancy);
    const key = slotKey(role);
    const displacedConnectionId = occupancy[key];
    if (displacedConnectionId) {
      this.byConnection.delete(displacedConnectionId);
    }
    occupancy[key] = connectionId;
    this.byConnection.set(connectionId, { deviceSid, role });
    return displacedConnectionId ? { displacedConnectionId } : {};
  }

  release(connectionId: string): RelayRoomRelease | undefined {
    const owned = this.byConnection.get(connectionId);
    if (!owned) return undefined;
    this.byConnection.delete(connectionId);
    const occupancy = this.rooms.get(owned.deviceSid);
    if (!occupancy) return { deviceSid: owned.deviceSid, role: owned.role };
    const key = slotKey(owned.role);
    if (occupancy[key] === connectionId) {
      delete occupancy[key];
    }
    const peerKey = slotKey(owned.role === "device" ? "terminal" : "device");
    const peerConnectionId = occupancy[peerKey];
    // 空房间不留在表里；凭证在 store 里，房间只表示「现在有人在」。
    if (!occupancy.deviceConnectionId && !occupancy.terminalConnectionId) {
      this.rooms.delete(owned.deviceSid);
    }
    return {
      deviceSid: owned.deviceSid,
      role: owned.role,
      ...(peerConnectionId ? { peerConnectionId } : {}),
    };
  }

  peerConnectionId(deviceSid: string, role: WebRemoteControlRelayRole): string | undefined {
    const occupancy = this.rooms.get(deviceSid);
    return occupancy?.[slotKey(role)];
  }

  status(deviceSid: string): WebRemoteControlRelayPairStatus {
    const occupancy = this.rooms.get(deviceSid);
    if (occupancy?.deviceConnectionId && occupancy.terminalConnectionId) {
      return "matched";
    }
    return "waiting";
  }

  /** 强制断开用：移除某个 sid 下的所有连接，返回它们的 connectionId。 */
  removeAll(deviceSid: string): string[] {
    const occupancy = this.rooms.get(deviceSid);
    if (!occupancy) return [];
    this.rooms.delete(deviceSid);
    const connectionIds: string[] = [];
    for (const connectionId of [occupancy.deviceConnectionId, occupancy.terminalConnectionId]) {
      if (!connectionId) continue;
      this.byConnection.delete(connectionId);
      connectionIds.push(connectionId);
    }
    return connectionIds;
  }

  sizes(): { rooms: number; paired: number } {
    let paired = 0;
    for (const deviceSid of this.rooms.keys()) {
      if (this.status(deviceSid) === "matched") paired += 1;
    }
    return { rooms: this.rooms.size, paired };
  }
}
