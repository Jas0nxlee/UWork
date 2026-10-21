import type {
  WebRemoteControlRelayDataMessage,
  WebRemoteControlRelayErrorCode,
  WebRemoteControlRelayIncomingMessage,
  WebRemoteControlRelayRole,
} from "@zcode/shared";

/**
 * relay 发出去的消息：除 `data` 外与 shared 一致。
 * `data` 的 payload 在 relay 侧是 unknown——它只搬运，不解析业务载荷。
 */
export type RelayOutgoingMessage =
  | Exclude<WebRemoteControlRelayIncomingMessage, WebRemoteControlRelayDataMessage<never>>
  | WebRemoteControlRelayDataMessage<unknown>;

/**
 * hub 视角的一条连接。实现方（src/connection.ts）负责帧上限、发送缓冲、空闲回收等传输细节；
 * hub 只关心「这条连接是谁、能不能收、要不要断开」。
 */
export interface RelayPeer {
  readonly connectionId: string;
  readonly remoteAddress: string;
  /** 鉴权成功前是 null。 */
  role(): WebRemoteControlRelayRole | null;
  deviceSid(): string | undefined;
  send(message: RelayOutgoingMessage): void;
  /** 发错误但保持连接：DEVICE_OFFLINE / INTERNAL 这类客户端会自行恢复的信号。 */
  notify(code: WebRemoteControlRelayErrorCode, message: string): void;
  /** 发错误并断开：AUTH_FAILED / KICKED / WRONG_PARAM。 */
  reject(code: WebRemoteControlRelayErrorCode, message: string): void;
  /** 鉴权成功时由 hub 回填身份，connection 用它做后续校验。 */
  commitAuth(role: WebRemoteControlRelayRole, deviceSid: string): void;
}
