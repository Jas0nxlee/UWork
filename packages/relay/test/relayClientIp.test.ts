import { describe, expect, it } from "vitest";
import { connectClient, startRelay } from "./helpers/relayHarness.js";

// 部署在反代/网关后面时，socket 来源永远是反代那一跳；必须能按 X-Forwarded-For 取真实客户端，
// 否则限流会把所有用户算成一个桶（一个人就能把别人挡在门外）。
describe("relay 客户端 IP 解析", () => {
  it("trustProxyHeaders 打开时按 X-Forwarded-For 第一跳区分客户端", async () => {
    const relay = await startRelay({ trustProxyHeaders: true, maxConnectionsPerIp: 1 });
    try {
      const first = await connectClient(relay, { headers: { "x-forwarded-for": "203.0.113.7" } });
      const second = await connectClient(relay, { headers: { "x-forwarded-for": "203.0.113.8" } });
      // 两个不同来源 IP + 每 IP 上限 1：都该放行。
      expect(first.socket.readyState).toBe(first.socket.OPEN);
      expect(second.socket.readyState).toBe(second.socket.OPEN);
      // 同一个来源 IP 的第三条则要被拒。
      await expect(
        connectClient(relay, { headers: { "x-forwarded-for": "203.0.113.7" } }),
      ).rejects.toThrow(/429/);
      first.close();
      second.close();
    } finally {
      await relay.close();
    }
  });

  it("trustProxyHeaders 关闭时不认这些头（默认，防伪造绕过限流）", async () => {
    const relay = await startRelay({ trustProxyHeaders: false, maxConnectionsPerIp: 1 });
    try {
      const first = await connectClient(relay, { headers: { "x-forwarded-for": "203.0.113.7" } });
      expect(first.socket.readyState).toBe(first.socket.OPEN);
      // 伪造不同的 XFF 也没用：仍然算同一个 socket 来源。
      await expect(
        connectClient(relay, { headers: { "x-forwarded-for": "203.0.113.8" } }),
      ).rejects.toThrow(/429/);
      first.close();
    } finally {
      await relay.close();
    }
  });

  it("X-Real-IP 作为 X-Forwarded-For 缺席时的兜底", async () => {
    const relay = await startRelay({ trustProxyHeaders: true, maxConnectionsPerIp: 1 });
    try {
      const first = await connectClient(relay, { headers: { "x-real-ip": "198.51.100.9" } });
      const second = await connectClient(relay, { headers: { "x-real-ip": "198.51.100.10" } });
      expect(first.socket.readyState).toBe(first.socket.OPEN);
      expect(second.socket.readyState).toBe(second.socket.OPEN);
      await expect(
        connectClient(relay, { headers: { "x-real-ip": "198.51.100.9" } }),
      ).rejects.toThrow(/429/);
      first.close();
      second.close();
    } finally {
      await relay.close();
    }
  });
});
