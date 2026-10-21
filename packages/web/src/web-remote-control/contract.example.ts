import type { WebRemoteControlEntryView } from "#src/web-remote-control/contract.js";
export const emptyDeviceList: WebRemoteControlEntryView = {
  kind: "devices",
  devices: [],
  loading: false,
  error: false,
};

/** UWork 构建在装配边界选择 HMAC；不能由企业或 OAuth 登录状态自动切换。 */
export const uworkRemoteProtocol: NonNullable<
  import("./contract.js").WebRemoteControlEntryOptions["protocol"]
> = "hmac-v1";
