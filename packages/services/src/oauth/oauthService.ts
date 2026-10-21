import type {
  ApiClient,
  OAuthCachedSessionRestoreResult,
  OAuthCallbackResult,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthSessionState,
  OAuthStartResponse,
  UserInfo,
} from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import type { ICredentialService } from "../credential/credential.js";
import type { IOAuthService } from "./oauth.js";

interface OAuthServiceDependencies {
  apiClient?: ApiClient;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  onProviderLogout?: (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void>;
}

// TODO(uwork-merge): 上游 3.16.2 在本文件内的账号实现改动（restoreCachedSessionState 的双凭据
// 过期检查、invalidateExpiredCachedSession 的 credentialKey 参数、登录/登出各点
// sessionChanges.fire）没有收下：本文件按 specs/custom-providers-only.md 的「OAuth RPC 读取恒为
// signed-out、登录/刷新明确失败、不发网络请求」保持退役桩，收下它们等于恢复已退役的登录实现，
// 会让 packages/services/test/customProvidersOnly.test.ts 的零网络断言失败。
// 只收下上游新增的 onDidChangeSession 事件成员：接口（oauth.ts）与消费方（远控鉴权同步）已按新
// 协议合并，登出路径按上游语义广播 signed-out。

/**
 * 登录已移除。保留旧 RPC 的明确退役响应，避免旧窗口/远端客户端重新打开账号链路。
 * 不读取、删除历史登录凭据，也不影响 credentialService 中的自定义 API Key。
 */
export class OAuthService implements IOAuthService {
  private readonly sessionChanges = new Emitter<OAuthSessionState>();
  readonly onDidChangeSession = this.sessionChanges.event;

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
  async logout(_provider?: OAuthProviderId): Promise<void> {
    // 退役桩不删除历史凭据；只按上游语义广播登出事实，让消费方撤销已认证的远控连接。
    this.sessionChanges.fire("signed-out");
  }
  async logoutAll(): Promise<void> {
    this.sessionChanges.fire("signed-out");
  }
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
