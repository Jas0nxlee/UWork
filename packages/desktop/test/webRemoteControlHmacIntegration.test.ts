import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, WebRemoteControlAppPayload } from "@zcode/shared";
import { parseWebRemoteControlHmacQrParams } from "@zcode/shared";
import { createWebRemoteControlManager } from "@desktop/main/webRemoteControlManager.js";
import { createWebRemoteControlFeatureGate } from "@desktop/main/webRemoteControlFeatureGate.js";
import {
  createNodeWebRemoteControlRelayAuthProvider,
  createWebRemoteControlRelayAuthStorageProvider,
} from "../src/main/web-remote-relay/index.js";
import {
  WebRemoteControlEntry,
  WebRemoteControlHmacTerminalTransport,
  createBrowserWebRemoteControlRelayAuthProvider,
} from "../../web/src/web-remote-control/index.js";
import { createHmacTestRelay } from "./helpers/hmacRelay.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: { relayWsUrl?: string; remoteUrl?: string } = {}) {
  const relay = await createHmacTestRelay();
  cleanups.push(() => relay.close());
  const credentials = new Map<string, string>();
  const settings: AppSettings = { recentProjects: [] };
  const getLogin = vi.fn(async () => undefined);
  const clearLegacy = vi.fn(async () => {});
  const attachWorkspaceHost = vi.fn(async () => {
    throw new Error("No Host before explicit bridge open");
  });
  const authStorage = createWebRemoteControlRelayAuthStorageProvider({
    credentialService: {
      load: async (key) => credentials.get(key) ?? null,
      save: async (key, value) => {
        credentials.set(key, value);
      },
      delete: async (key) => {
        credentials.delete(key);
      },
    },
    loadSettings: async () => settings,
    patchSettings: async (patch) => {
      Object.assign(settings, patch);
    },
  });
  const manager = createWebRemoteControlManager({
    hmacRelay: {
      authProvider: createNodeWebRemoteControlRelayAuthProvider(),
      authStorageProvider: authStorage,
    },
    relayWsUrl: options.relayWsUrl ?? relay.wsUrl,
    mobileRemoteControlUrl: options.remoteUrl ?? `${relay.httpUrl}/remote/v4`,
    deviceMid: "test-desktop",
    deviceName: "UWork Desktop",
    appVersion: "3.16.6",
    getLogin,
    deviceStorage: { load: async () => undefined, save: async () => {}, clearLegacy },
    startupRestoreStorageProvider: {
      load: async () => settings.webRemoteControlLastEnabledContext,
      save: async (value) => {
        settings.webRemoteControlLastEnabledContext = value;
      },
      clear: async () => {
        settings.webRemoteControlLastEnabledContext = undefined;
      },
    },
    featureGate: createWebRemoteControlFeatureGate(true),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    platformHandlers: {
      isDockerAvailable: async () => false,
      listWSLDistros: async () => [],
      listDockerContainers: async () => [],
      listSSHConfigAliases: async () => [],
      loadMcpFromUserDirectory: async () => ({ servers: [] }),
      saveMcpToUserDirectory: async () => ({ success: true }),
      migrateLegacyCommonMcp: async () => ({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    },
    reconnectWorkspace: async () => {},
    attachWorkspaceHost,
    releaseWorkspaceHostAttachment: () => {},
    disposeWorkspaceHostAttachmentsForWindow: () => {},
    disposeWorkspaceHostAttachmentsForRemoteSession: () => {},
  });
  cleanups.push(async () => {
    await manager.suspend(1, "test-cleanup");
    await manager.suspend(2, "test-cleanup");
  });
  const context = { workspacePath: "/test-workspace" };
  const start = (windowId = 1) =>
    manager.startAuthorized(windowId, context, manager.authorizeStart(windowId, context));
  manager.syncAvailableWorkspaces(1, [{ ...context, label: "Test workspace", kind: "local" }]);
  return {
    relay,
    manager,
    start,
    settings,
    authStorage,
    getLogin,
    clearLegacy,
    attachWorkspaceHost,
  };
}

describe("UWork HMAC 双端真实 loopback 配对", () => {
  it("未配置自建端点时失败关闭，不向官方 V2 发送 HMAC 或读取账号", async () => {
    const f = await fixture({ relayWsUrl: "wss://zcode.z.ai/ws" });
    await expect(f.start()).rejects.toThrow("self-hosted relay endpoints are required");
    expect(f.relay.messages).toEqual([]);
    expect(f.getLogin).not.toHaveBeenCalled();
    expect(f.manager.getStatus(1)).toEqual({ status: "idle" });
  });

  it("持久化 SID 从窗口1切到窗口2时先释放旧 device owner，保留配对材料且不争抢 socket", async () => {
    const f = await fixture();
    const first = parseWebRemoteControlHmacQrParams(
      new URL((await f.start(1)).qrUrl).searchParams,
    )!;
    const second = parseWebRemoteControlHmacQrParams(
      new URL((await f.start(2)).qrUrl).searchParams,
    )!;
    expect(second.deviceSid).toBe(first.deviceSid);
    expect(second.passHash).toBe(first.passHash);
    expect(f.manager.getStatus(1)).toEqual({ status: "idle" });
    expect(f.manager.getStatus(2).status).toBe("running");
    expect(
      f.relay.messages.filter((message) => message.type === "device_register_init"),
    ).toHaveLength(1);
    expect(await f.authStorage.load()).toMatchObject({
      deviceSid: second.deviceSid,
      passHash: second.passHash,
    });
  });

  it("两个窗口同时首次开启时新 owner 撤销旧启动，只注册并保存当前窗口配对", async () => {
    const f = await fixture();
    const first = f.start(1).catch((error: unknown) => error);
    const second = f.start(2);
    expect(await first).toBeInstanceOf(Error);
    const result = await second;
    expect(f.manager.getStatus(1)).toEqual({ status: "idle" });
    expect(f.manager.getStatus(2).status).toBe("running");
    const params = parseWebRemoteControlHmacQrParams(new URL(result.qrUrl).searchParams)!;
    expect(await f.authStorage.load()).toMatchObject({
      deviceSid: params.deviceSid,
      passHash: params.passHash,
    });
    expect(
      f.relay.messages.filter((message) => message.type === "device_register_init"),
    ).toHaveLength(1);
  });

  it("轮换撤销旧连接并注册新 SID/hash，不恢复旧配对材料", async () => {
    const f = await fixture();
    const before = parseWebRemoteControlHmacQrParams(
      new URL((await f.start()).qrUrl).searchParams,
    )!;
    const context = { workspacePath: "/test-workspace" };
    const result = await f.manager.resetPairingAuthorized(
      1,
      context,
      f.manager.authorizeStart(1, context),
    );
    const after = parseWebRemoteControlHmacQrParams(new URL(result.qrUrl).searchParams)!;
    expect(after.deviceSid).not.toBe(before.deviceSid);
    expect(after.passHash).not.toBe(before.passHash);
    expect(await f.authStorage.load()).toMatchObject({
      deviceSid: after.deviceSid,
      passHash: after.passHash,
    });
    expect(f.getLogin).not.toHaveBeenCalled();
  });

  it("stop 在慢配对读取期间撤销生命周期，迟到读取不能注册 relay 或复活 runtime", async () => {
    const f = await fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.spyOn(f.authStorage, "load").mockImplementation(async () => {
      await pending;
      return undefined;
    });
    const starting = f.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const stopped = f.manager.stop(1);
    // 连接和 lease 同步撤销；磁盘清理按同一队列等待在途读取结算。
    expect(f.manager.getStatus(1).status).toBe("idle");
    release();
    await stopped;
    expect(await starting).toBeInstanceOf(Error);
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(f.relay.messages).toEqual([]);
  });

  it("轮换期间用户停止，迟到清理不能重新启动设备", async () => {
    const f = await fixture();
    await f.start();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.authStorage.clear.bind(f.authStorage);
    const clear = vi.spyOn(f.authStorage, "clear").mockImplementation(async () => {
      await pending;
      await original();
    });
    const context = { workspacePath: "/test-workspace" };
    const rotating = f.manager
      .resetPairingAuthorized(1, context, f.manager.authorizeStart(1, context))
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(clear).toHaveBeenCalled());
    const stopped = f.manager.stop(1);
    release();
    await stopped;
    expect(await rotating).toBeInstanceOf(Error);
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(f.settings.webRemoteControlLastEnabledContext).toBeUndefined();
  });

  it("stop 等待在途配对保存结算后清理启用意图，迟到保存不能复活 runtime", async () => {
    const f = await fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.authStorage.save.bind(f.authStorage);
    const save = vi.spyOn(f.authStorage, "save").mockImplementation(async (auth) => {
      await pending;
      await original(auth);
    });
    const starting = f.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    const stopped = f.manager.stop(1);
    release();
    await stopped;
    expect(await starting).toBeInstanceOf(Error);
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(f.settings.webRemoteControlLastEnabledContext).toBeUndefined();
  });

  it("旧 owner 的失效凭据清理与新 owner 读取串行，不擦除新保存的配对", async () => {
    const f = await fixture();
    await f.authStorage.save({ deviceSid: "missing-room", passHash: "obsolete-hash" });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.authStorage.clear.bind(f.authStorage);
    const clear = vi.spyOn(f.authStorage, "clear").mockImplementation(async () => {
      await pending;
      await original();
    });
    const first = f.start(1).catch((error: unknown) => error);
    await vi.waitFor(() => expect(clear).toHaveBeenCalled());
    const second = f.start(2);
    release();
    expect(await first).toBeInstanceOf(Error);
    const result = await second;
    const params = parseWebRemoteControlHmacQrParams(new URL(result.qrUrl).searchParams)!;
    expect(await f.authStorage.load()).toMatchObject({
      deviceSid: params.deviceSid,
      passHash: params.passHash,
    });
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(f.manager.getStatus(2).status).toBe("running");
  });

  it("无 OAuth 桌面生成 QR，手机绕过登录并完成 workspace 请求；停止保留配对，再启动复用 SID", async () => {
    const f = await fixture();
    const result = await f.start();
    const params = parseWebRemoteControlHmacQrParams(new URL(result.qrUrl).searchParams)!;
    expect(params).toMatchObject({ deviceMid: "test-desktop", deviceName: "UWork Desktop" });
    expect(await f.authStorage.load()).toMatchObject({
      deviceSid: params.deviceSid,
      passHash: params.passHash,
    });
    expect(f.getLogin).not.toHaveBeenCalled();
    expect(f.clearLegacy).not.toHaveBeenCalled();
    const auth = {
      getZCodeJwtToken: vi.fn(() => null),
      getActiveAccount: vi.fn(() => null),
      startLogin: vi.fn(),
      logout: vi.fn(async () => {}),
    };
    const received: WebRemoteControlAppPayload[] = [];
    const devices = vi.fn(async () => []),
      token = vi.fn(async () => "should-not-read");
    const terminalStates: string[] = [];
    let terminal: WebRemoteControlHmacTerminalTransport | undefined;
    const entry = new WebRemoteControlEntry({
      protocol: "hmac-v1",
      auth,
      getHref: () => result.qrUrl,
      replaceHref: vi.fn(),
      storage: { getItem: () => null, setItem: () => {} },
      locale: "zh-CN",
      devices,
      token,
      subscribeVisible: () => () => {},
      onView: vi.fn(),
      connect: (connection) => {
        terminal = new WebRemoteControlHmacTerminalTransport({
          relayWsUrl: f.relay.wsUrl,
          deviceSid: connection.params.deviceSid,
          passHash: connection.params.passHash!,
          authProvider: createBrowserWebRemoteControlRelayAuthProvider(),
          WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
          onStateChange: (state) => {
            terminalStates.push(state);
          },
          onFailure: vi.fn(),
          onError: vi.fn(),
          reloadPage: vi.fn(),
          onPayload: (payload) => received.push(payload),
        });
        cleanups.push(() => terminal?.dispose());
        terminal.start();
        cleanups.push(() => entry.dispose());
      },
    });
    await entry.start();
    await vi.waitFor(() => expect(terminalStates).toContain("paired"));
    terminal!.sendPayload({ zcode_type: "workspace-list-request", requestId: "hmac-list" });
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-list-response",
          requestId: "hmac-list",
          success: true,
        }),
      ),
    );
    expect(auth.getZCodeJwtToken).not.toHaveBeenCalled();
    expect(auth.startLogin).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(devices).not.toHaveBeenCalled();
    expect(f.attachWorkspaceHost).not.toHaveBeenCalled();
    await f.manager.notifyAuthStateChanged(1, { state: "signed-out" });
    expect(f.manager.getStatus(1).status).toBe("active");
    await f.manager.stop(1);
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(await f.authStorage.load()).toMatchObject({
      deviceSid: params.deviceSid,
      passHash: params.passHash,
    });
    const resumed = await f.start();
    expect(parseWebRemoteControlHmacQrParams(new URL(resumed.qrUrl).searchParams)).toMatchObject({
      deviceSid: params.deviceSid,
      passHash: params.passHash,
    });
  });
});
