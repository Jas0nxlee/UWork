import { expect, it, vi } from "vitest";
import { ProxyChannel } from "@zcode/rpc";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import type { IOAuthService } from "#src/oauth/oauth.js";
import { createOAuthService } from "#src/oauth/oauthService.js";

function fixture() {
  const credentials = new Map([
    ["oauth:active_provider", ZAI_PROVIDER_ID],
    ["zcodejwttoken", "historical-token"],
    ["custom-api-key", "personal-key"],
  ]);
  const before = new Map(credentials);
  const store = {
    load: vi.fn(async (key: string) => credentials.get(key) ?? null),
    save: vi.fn(async (key: string, value: string) => {
      credentials.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      credentials.delete(key);
    }),
  };
  const request = vi.fn<typeof fetch>();
  const onProviderLogout = vi.fn(async () => {});
  const service = createOAuthService(store, { apiClient: { request }, onProviderLogout });
  const server = ProxyChannel.fromService(service);
  const client = ProxyChannel.toService<IOAuthService>({
    call: (command, args) => server.call(undefined, command, args),
    listen: (event, args) => server.listen(undefined, event, args),
  });
  const changed = vi.fn();
  const subscription = client.onDidChangeSession(changed);
  return { client, changed, subscription, credentials, before, store, request, onProviderLogout };
}

// 修复依据：UWork 退役 OAuth 合同禁止恢复上游账号链路，RPC 事件测试必须验证同一边界。
it("历史凭据恢复经 RPC 保持 signed-out，不发布已登录事件或接触凭据", async () => {
  const f = fixture();
  try {
    expect(await f.client.restoreCachedSessionState()).toEqual({ status: "signed-out" });
    expect(await f.client.restoreCachedSession()).toBeNull();
    expect(await f.client.restoreSession()).toBeNull();
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.store.load).not.toHaveBeenCalled();
    expect(f.credentials).toEqual(f.before);
  } finally {
    f.subscription.dispose();
  }
});

it.each([ZAI_PROVIDER_ID, BIGMODEL_PROVIDER_ID])(
  "%s 登录和刷新经 RPC 明确失败，不发布 signed-in",
  async (provider) => {
    const f = fixture();
    try {
      await expect(f.client.startOAuth(provider)).rejects.toThrow("应用登录已移除");
      await expect(f.client.startOAuthWithPolling(provider)).rejects.toThrow("应用登录已移除");
      await expect(f.client.refreshToken(provider)).rejects.toThrow("应用登录已移除");
      expect(
        await f.client.handleCallback("zcode://oauth/callback?state=test&code=test"),
      ).toBeNull();
      expect(await f.client.pollPendingOAuth()).toBeNull();
      await f.client.cancelPending(provider);
      expect(f.changed).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
      expect(f.credentials).toEqual(f.before);
    } finally {
      f.subscription.dispose();
    }
  },
);

it.each(["active", "provider", "all"] as const)(
  "%s 登出经 RPC 发布 signed-out，保留历史凭据与个人 Key",
  async (mode) => {
    const f = fixture();
    try {
      if (mode === "all") await f.client.logoutAll();
      else await f.client.logout(mode === "provider" ? BIGMODEL_PROVIDER_ID : undefined);
      expect(f.changed.mock.calls).toEqual([["signed-out"]]);
      expect(f.credentials).toEqual(f.before);
      expect(f.onProviderLogout).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
      f.subscription.dispose();
      await f.client.logoutAll();
      expect(f.changed).toHaveBeenCalledTimes(1);
    } finally {
      f.subscription.dispose();
    }
  },
);
