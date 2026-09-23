import type {
  OAuthCachedSessionRestoreResult,
  OAuthCallbackResult,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthStartResponse,
  UserInfo,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 登录退役后的兼容 RPC。读取恒为 signed-out；登录和刷新明确报错，不执行网络 IO。 */
export interface IOAuthService {
  getProviders(): Promise<OAuthProviderMeta[]>;
  getActiveProvider(): Promise<OAuthProviderId | null>;
  restoreCachedSession(): Promise<UserInfo | null>;
  restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult>;
  restoreSession(): Promise<UserInfo | null>;
  /** 不再创建授权流程，拒绝旧客户端的登录请求。 */
  startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse>;
  startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse>;
  pollPendingOAuth(): Promise<OAuthCallbackResult | null>;
  handleCallback(url: string): Promise<OAuthCallbackResult | null>;
  refreshToken(provider?: OAuthProviderId): Promise<void>;
  /** 无活动会话；不会删除留作回退的历史凭据。 */
  logout(provider?: OAuthProviderId): Promise<void>;
  logoutAll(): Promise<void>;
  cancelPending(provider?: OAuthProviderId): Promise<void>;
}

export const IOAuthService = createServiceDescriptor<IOAuthService>(ServiceChannels.OAuth);
