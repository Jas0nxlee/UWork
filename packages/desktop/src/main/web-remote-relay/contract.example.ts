import type { WebRemoteControlDeviceStorage } from "#src/main/web-remote-relay/contract.js";
export async function restoreRegisteredDevice(storage: WebRemoteControlDeviceStorage) {
  await storage.clearLegacy();
  return storage.load();
}

/** 配对材料只留 Main 侧；HMAC 不从账号状态派生。 */
export async function restoreHmacPairing(
  storage: import("./contract.js").WebRemoteControlRelayAuthStorageProvider,
) {
  return storage.load();
}
