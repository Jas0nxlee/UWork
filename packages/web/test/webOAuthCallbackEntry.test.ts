// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://zcode.z.ai/"}
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots = vi.hoisted(() => [] as Root[]);

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      const root = actual.createRoot(...args);
      roots.push(root);
      return root;
    },
  };
});

vi.mock("@zcode/ui", () => ({
  AppErrorBoundary: () => null,
  Root: () => null,
  ZCodeIntlProvider: () => null,
  Button: () => null,
  generateMobileDeviceFingerprint: () => "oauth-entry-test",
  installDocumentHiddenMotionPause: vi.fn(),
  playTaskNotificationSound: vi.fn(),
  setStreamClientId: vi.fn(),
  setWebRemoteControlTerminalTransportState: vi.fn(),
}));

vi.mock("@web/share/ConversationShareLandingPage.js", () => ({
  ConversationShareLandingLoader: () => "share-preview",
  ConversationShareLandingStatus: () => "invalid-share",
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.lang = "en";
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function bootstrap(path: string, query: string, protocol?: "hmac-v1" | "oauth-v2") {
  vi.stubEnv("VITE_WEB_REMOTE_CONTROL_PROTOCOL", protocol);
  window.history.replaceState(null, "", `${path}?${query}`);
  const { WebAuthService } = await import("@web/auth/webAuthService.js");
  // 保留真实入口和回调组件 effect；服务内部的 nonce/token 契约由 webAuthService.test 覆盖。
  const handleCallback = vi
    .spyOn(WebAuthService.prototype, "handleCallback")
    .mockResolvedValue(null);
  await act(async () => {
    await import("@web/main.js");
  });
  return handleCallback;
}

describe("Web OAuth callback entry", () => {
  for (const path of ["/share/callback", "/cn/share/callback", "/remote/v4", "/remote/v4/"]) {
    it.each(["authCode=bigmodel-code", "code=zai-code", "error=access_denied"])(
      `${path} 的 %s 渲染回调页并交给认证服务`,
      async (result) => {
        // 分享认证独立保留；远控账号回调只属于显式 V2，默认 HMAC 不得自动降级。
        const handleCallback = await bootstrap(
          path,
          `state=entry-state&${result}`,
          path.startsWith("/remote/") ? "oauth-v2" : undefined,
        );
        expect(document.body.textContent).toContain("Finishing Sign-In");
        expect(handleCallback).toHaveBeenCalledExactlyOnceWith(window.location.href);
      },
    );
  }

  for (const path of ["/remote/v4", "/remote/v4/"]) {
    it.each(["authCode=bigmodel-code", "code=zai-code", "error=access_denied"])(
      `默认 HMAC ${path} 不消费官方 OAuth 回调：%s`,
      async (result) => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const { WebAuthService } = await import("@web/auth/webAuthService.js");
        const startLogin = vi.spyOn(WebAuthService.prototype, "startLogin");
        const handleCallback = await bootstrap(path, `state=entry-state&${result}`);
        expect(document.body.textContent).toContain("Scan the desktop QR code");
        expect(document.body.textContent).not.toContain("Finishing Sign-In");
        expect(handleCallback).not.toHaveBeenCalled();
        expect(startLogin).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
  }

  for (const path of ["/share/callback", "/cn/share/callback"]) {
    it.each(["authCode=code", "code=code", "error=access_denied", "state=entry-state"])(
      `${path} 缺少 state 或结果参数时不进入回调页：%s`,
      async (query) => {
        const handleCallback = await bootstrap(path, query);
        expect(handleCallback).not.toHaveBeenCalled();
        expect(document.body.textContent).toBe("share-preview");
      },
    );
  }

  it("普通分享路径即使携带 OAuth 参数也保持预览路由", async () => {
    const handleCallback = await bootstrap("/share/example", "state=entry-state&authCode=code");
    expect(handleCallback).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("share-preview");
  });
});
