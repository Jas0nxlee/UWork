/**
 * relay 的公开入口：只有服务构造、配置与鉴权原语。
 * 协议行为契约见 specs/web-remote-control-relay.md。
 */
export { calculateRelayAuthProof, verifyRelayAuthProof } from "./auth.js";
export {
  createRelayConfig,
  readRelayConfigFromEnv,
  RELAY_DEFAULT_CONFIG,
  type RelayConfig,
} from "./config.js";
export { createRelayServer, type RelayHealth, type RelayServer } from "./server.js";
export { RelayDeviceStore, type RelayDeviceRecord } from "./store.js";
