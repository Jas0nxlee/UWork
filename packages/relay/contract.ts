/**
 * relay 模块的公开契约（可执行部分在 src/index.ts，行为契约在
 * specs/web-remote-control-relay.md）。
 */
export {
  calculateRelayAuthProof,
  createRelayConfig,
  createRelayServer,
  readRelayConfigFromEnv,
  verifyRelayAuthProof,
  RELAY_DEFAULT_CONFIG,
  type RelayConfig,
  type RelayHealth,
  type RelayServer,
} from "./src/index.js";

/** relay 只做这四件事；任何新增职责都要先改 spec。 */
export const RELAY_RESPONSIBILITIES = [
  "register-device",
  "authenticate-pair",
  "answer-heartbeat",
  "forward-data",
] as const;

/**
 * 错误码语义：必须与 packages/shared 的 `WebRemoteControlRelayErrorCode` 一一对应，
 * 且与两侧客户端的恢复分支一致（spec 第二节）。
 */
export const RELAY_ERROR_SEMANTICS = {
  AUTH_FAILED: "注册或鉴权不通过；桌面据此重新注册新 sid",
  DEVICE_OFFLINE: "该 sid 上没有在线桌面；手机据此进入可恢复宽限窗口",
  KICKED: "同角色槽位被新连接顶替（第二个手机 / 桌面重连后的旧 socket）",
  WRONG_PARAM: "未鉴权阶段的畸形或错序消息",
  INTERNAL: "服务端侧问题（超限帧、无对端可投递）；丢帧不断连",
} as const;

export type RelayErrorCode = keyof typeof RELAY_ERROR_SEMANTICS;
