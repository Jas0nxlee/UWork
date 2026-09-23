import type {
  ApiClient,
  OAuthCachedSessionRestoreResult,
  OAuthCallbackResult,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthStartResponse,
  UserInfo,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { IOAuthService } from "./oauth.js";

interface OAuthServiceDependencies {
  apiClient?: ApiClient;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  onProviderLogout?: (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void>;
}

/**
 * 登录已移除。保留旧 RPC 的明确退役响应，避免旧窗口/远端客户端重新打开账号链路。
 * 不读取、删除历史登录凭据，也不影响 credentialService 中的自定义 API Key。
 */
export class OAuthService implements IOAuthService {
  async getProviders(): Promise<OAuthProviderMeta[]> {
    return [];
  }
  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return null;
  }
  async restoreCachedSession(): Promise<UserInfo | null> {
    return null;
  }
  async restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    return { status: "signed-out" };
  }
  async restoreSession(): Promise<UserInfo | null> {
    return null;
  }
  async startOAuth(_provider: OAuthProviderId): Promise<OAuthStartResponse> {
    throw new Error("应用登录已移除，请在模型设置中配置自定义供应商");
  }
  async startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    return this.startOAuth(provider);
  }
  async pollPendingOAuth(): Promise<OAuthCallbackResult | null> {
    return null;
  }
  async handleCallback(_url: string): Promise<OAuthCallbackResult | null> {
    return null;
  }
  async refreshToken(_provider?: OAuthProviderId): Promise<void> {
    throw new Error("应用登录已移除，不再刷新账号凭据");
  }
  async logout(_provider?: OAuthProviderId): Promise<void> {}
  async logoutAll(): Promise<void> {}
  async cancelPending(_provider?: OAuthProviderId): Promise<void> {}
  async logoutIfCurrentCredentialRequest(
    _input: string | URL,
    _headers: Headers,
  ): Promise<boolean> {
    return false;
  }
}

export function createOAuthService(
  _credentialService: ICredentialService,
  _dependencies: OAuthServiceDependencies = {},
): OAuthService {
  return new OAuthService();
}
