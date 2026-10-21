import { describe, expect, it } from "vitest";
import type { RelayHealth } from "../src/index.js";
import {
  connectClient,
  pairDeviceAndTerminal,
  startRelay,
  type RelayTestServer,
} from "./helpers/relayHarness.js";

function httpBase(relay: RelayTestServer): string {
  return `http://127.0.0.1:${relay.port}`;
}

describe("relay 运维面", () => {
  it("/health 暴露房间/连接/配对计数", async () => {
    const relay = await startRelay({ version: "test-1" });
    try {
      const before = (await (await fetch(`${httpBase(relay)}/health`)).json()) as RelayHealth;
      expect(before).toMatchObject({
        status: "ok",
        version: "test-1",
        rooms: 0,
        paired: 0,
        devices: 0,
      });

      const { device, terminal } = await pairDeviceAndTerminal(relay);
      const after = (await (await fetch(`${httpBase(relay)}/health`)).json()) as RelayHealth;
      expect(after).toMatchObject({
        status: "ok",
        rooms: 1,
        paired: 1,
        connections: 2,
        devices: 1,
      });
      expect(typeof after.uptimeMs).toBe("number");

      device.close();
      terminal.close();
    } finally {
      await relay.close();
    }
  });

  it("未配置 admin token 时 /admin/disconnect 整体禁用（404）", async () => {
    const relay = await startRelay();
    try {
      const response = await fetch(`${httpBase(relay)}/admin/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceSid: "whatever" }),
      });
      expect(response.status).toBe(404);
    } finally {
      await relay.close();
    }
  });

  it("admin token 正确才生效；被断开的桌面会收到 AUTH_FAILED（据此重新注册新 sid）", async () => {
    const relay = await startRelay({ adminToken: "s3cret" });
    try {
      const { device, terminal, deviceSid } = await pairDeviceAndTerminal(relay);

      const unauthorized = await fetch(`${httpBase(relay)}/admin/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        body: JSON.stringify({ deviceSid }),
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(`${httpBase(relay)}/admin/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
        body: JSON.stringify({ deviceSid }),
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toEqual({ disconnected: 2 });

      const deviceError = await device.waitForErrorCode("AUTH_FAILED");
      expect(deviceError.message).toBe("disconnected-by-admin");
      const terminalError = await terminal.waitForErrorCode("AUTH_FAILED");
      expect(terminalError.message).toBe("disconnected-by-admin");
      await device.closed;
      await terminal.closed;

      // 断开后房间与计数都要归零，否则运维看不到真实占用。
      const health = (await (await fetch(`${httpBase(relay)}/health`)).json()) as RelayHealth;
      expect(health).toMatchObject({ rooms: 0, paired: 0, connections: 0 });
    } finally {
      await relay.close();
    }
  });

  it("对未知 sid 调 admin 断开是幂等的（返回 0）", async () => {
    const relay = await startRelay({ adminToken: "s3cret" });
    try {
      const response = await fetch(`${httpBase(relay)}/admin/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
        body: JSON.stringify({ deviceSid: "not-a-room" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ disconnected: 0 });
    } finally {
      await relay.close();
    }
  });

  it("关闭服务时把在线连接以 1001 断开并落盘", async () => {
    const relay = await startRelay();
    const client = await connectClient(relay);
    await relay.close();
    const closeInfo = await client.closed;
    expect(closeInfo.code).toBe(1001);
  });
});
