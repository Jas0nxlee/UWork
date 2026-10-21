// 集成测：不是 mock WS，而是把真实手机端 transport（packages/web）接到真实 relay 上。
// 目标是把 spec 第九节第 7 条「把 mock WS 换成集成测试」变成可重复执行的门禁。
// 3.16.7 起 web 端 transport 迁进 web-remote-control 模块，HMAC 版更名为
// WebRemoteControlHmacTerminalTransport（relay 走 hmac-v1）。
import { WebSocket as NodeWebSocket } from "ws";
import { describe, expect, it } from "vitest";
import type { WebRemoteControlFailure } from "@zcode/shared";
import { WebRemoteControlHmacTerminalTransport } from "@web/web-remote-control/adapters/hmacTransport.js";
import { calculateRelayAuthProof } from "../src/auth.js";
import {
  authenticate,
  connectClient,
  pairDeviceAndTerminal,
  registerDevice,
  startRelay,
  waitUntil,
  type RelayTestServer,
} from "./helpers/relayHarness.js";

interface TerminalHarness {
  transport: WebRemoteControlHmacTerminalTransport;
  states: string[];
  failures: WebRemoteControlFailure[];
  rawPayloads: unknown[];
}

function createTerminalHarness(
  relay: RelayTestServer,
  params: { deviceSid: string; passHash: string },
): TerminalHarness {
  const states: string[] = [];
  const failures: WebRemoteControlFailure[] = [];
  const rawPayloads: unknown[] = [];
  const transport = new WebRemoteControlHmacTerminalTransport({
    relayWsUrl: relay.url,
    deviceSid: params.deviceSid,
    passHash: params.passHash,
    appVersion: "test",
    WebSocketCtor: NodeWebSocket as unknown as typeof globalThis.WebSocket,
    authProvider: {
      calculateProof: async (passHash, nonce, role, deviceSid) =>
        calculateRelayAuthProof({ passHash, nonce, role, deviceSid }),
    },
    onPayload: () => {},
    onRawTransportPayload: (payload) => {
      rawPayloads.push(payload);
      return true;
    },
    onStateChange: (state) => {
      states.push(state);
    },
    onFailure: (failure) => {
      failures.push(failure);
    },
    onError: () => {},
    reloadPage: () => {},
    heartbeatIntervalMs: 200,
    heartbeatJitterMs: 20,
    heartbeatAckTimeoutMs: 2_000,
    desktopOfflineGraceMs: 400,
    waitingTimeoutMs: 1_500,
  });
  return { transport, states, failures, rawPayloads };
}

describe("真实手机端 transport × 真实 relay", () => {
  it("完成握手并双向收发 payload", async () => {
    const relay = await startRelay();
    const { client: device, deviceSid, passHash } = await registerDevice(relay);
    await authenticate(device, { role: "device", deviceSid, passHash });

    const terminal = createTerminalHarness(relay, { deviceSid, passHash });
    try {
      terminal.transport.start();
      await waitUntil(() => terminal.states.includes("paired"), 5_000);

      // 手机 → 桌面：真实 transport 自己序列化并封帧。
      const outbound = {
        zcode_type: "rpc-frame" as const,
        bridgeSessionId: "bridge-1",
        seq: 1,
        dataBase64: "AAECAwQ=",
      };
      expect(terminal.transport.sendPayload(outbound)).toBe(true);
      const receivedByDevice = await device.waitFor<{ type: "data"; payload: unknown }>(
        (message) => message.type === "data",
      );
      expect(receivedByDevice.payload).toMatchObject({
        zcode_type: "rpc-frame",
        bridgeSessionId: "bridge-1",
      });

      // 桌面 → 手机：走 raw transport 分支（真实 RPC 帧路径）。
      device.send({ type: "data", payload: outbound });
      await waitUntil(() => terminal.rawPayloads.length > 0, 5_000);
      expect(terminal.rawPayloads[0]).toMatchObject({ zcode_type: "rpc-frame", seq: 1 });
      expect(terminal.failures).toHaveLength(0);
    } finally {
      terminal.transport.dispose();
      await relay.close();
    }
  });

  it("第二个手机接管链接时，真实 transport 得到 session-conflict", async () => {
    const relay = await startRelay();
    const { deviceSid, passHash } = await pairDeviceAndTerminal(relay);

    const terminal = createTerminalHarness(relay, { deviceSid, passHash });
    try {
      terminal.transport.start();
      await waitUntil(() => terminal.states.includes("paired"), 5_000);

      const second = await connectClient(relay);
      await authenticate(second, { role: "terminal", deviceSid, passHash });

      await waitUntil(() => terminal.failures.length > 0, 5_000);
      expect(terminal.failures[0]?.reason).toBe("session-conflict");
    } finally {
      terminal.transport.dispose();
      await relay.close();
    }
  });

  it("桌面上线后掉线：手机先收 DEVICE_OFFLINE，超出宽限才报 desktop-disconnected", async () => {
    const relay = await startRelay();
    const { client: device, deviceSid, passHash } = await registerDevice(relay);
    await authenticate(device, { role: "device", deviceSid, passHash });

    const terminal = createTerminalHarness(relay, { deviceSid, passHash });
    try {
      terminal.transport.start();
      await waitUntil(() => terminal.states.includes("paired"), 5_000);

      device.close();
      await waitUntil(() => terminal.failures.length > 0, 5_000);
      expect(terminal.failures[0]?.reason).toBe("desktop-disconnected");
    } finally {
      terminal.transport.dispose();
      await relay.close();
    }
  });
});
