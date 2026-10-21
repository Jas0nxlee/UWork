import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  authenticate,
  connectClient,
  pairDeviceAndTerminal,
  registerDevice,
  startRelay,
  DEVICE_META,
} from "./helpers/relayHarness.js";

describe("relay 传输面加固", () => {
  it("超限帧 → INTERNAL 丢帧但不断连", async () => {
    const relay = await startRelay({ maxFrameBytes: 512 });
    try {
      const { device } = await pairDeviceAndTerminal(relay);
      device.send({ type: "data", payload: "x".repeat(2_048) });
      const error = await device.waitForErrorCode("INTERNAL");
      expect(error.message).toBe("frame-over-limit");
      expect(device.closeInfo).toBeUndefined();

      // 连接仍然可用：心跳照常被应答。
      await device.waitFor((message) => message.type === "pair_status_ack", 500).catch(() => {});
      device.send({ type: "pair_status_query", device_sid: "whatever-own-sid" });
      const answer = await device.waitFor<{
        type: "pair_status_ack";
        pair_status: "waiting" | "matched";
      }>((message) => message.type === "pair_status_ack");
      expect(answer.type).toBe("pair_status_ack");
    } finally {
      await relay.close();
    }
  });

  it("未鉴权阶段发畸形消息 → WRONG_PARAM 并断开", async () => {
    const relay = await startRelay();
    try {
      const client = await connectClient(relay);
      client.socket.send("这不是 JSON");
      const error = await client.waitForErrorCode("WRONG_PARAM");
      expect(error.message).toBe("malformed-json");
      await client.closed;
    } finally {
      await relay.close();
    }
  });

  it("已鉴权后一帧坏数据不拆会话", async () => {
    const relay = await startRelay();
    try {
      const { device, deviceSid } = await pairDeviceAndTerminal(relay);
      device.send("{ 半截 JSON");
      device.send({ type: "pair_status_query", device_sid: deviceSid });
      const answer = await device.waitFor<{
        type: "pair_status_ack";
        pair_status: "waiting" | "matched";
      }>((message) => message.type === "pair_status_ack");
      expect(answer.type).toBe("pair_status_ack");
      expect(device.errors).toHaveLength(0);
    } finally {
      await relay.close();
    }
  });

  it("投递不到对端时回 INTERNAL 且保持连接（客户端按可恢复处理）", async () => {
    const relay = await startRelay();
    try {
      const { client: device, deviceSid, passHash } = await registerDevice(relay);
      await authenticate(device, { role: "device", deviceSid, passHash });
      device.send({ type: "data", payload: { zcode_type: "rpc-frame", seq: 1 } });
      const error = await device.waitForErrorCode("INTERNAL");
      expect(error.message).toBe("no-paired-peer");
      expect(device.closeInfo).toBeUndefined();
    } finally {
      await relay.close();
    }
  });

  it("未鉴权就发 data / pair_status_query → WRONG_PARAM", async () => {
    const relay = await startRelay();
    try {
      const client = await connectClient(relay);
      client.send({ type: "data", payload: { a: 1 } });
      const error = await client.waitForErrorCode("WRONG_PARAM");
      expect(error.message).toBe("data-before-auth");
      await client.closed;
    } finally {
      await relay.close();
    }
  });

  it("无上行流量超过空闲阈值才回收（等扫码的桌面有心跳，不会被误杀）", async () => {
    const relay = await startRelay({ idleTimeoutMs: 150, idleSweepIntervalMs: 30 });
    try {
      const client = await connectClient(relay);
      const closeInfo = await client.closed;
      expect(closeInfo.code).toBe(1001);
      expect(closeInfo.reason).toBe("idle");
    } finally {
      await relay.close();
    }
  });

  it("有心跳的连接不会被空闲回收", async () => {
    const relay = await startRelay({ idleTimeoutMs: 150, idleSweepIntervalMs: 30 });
    try {
      const { client: device, deviceSid, passHash } = await registerDevice(relay);
      await authenticate(device, { role: "device", deviceSid, passHash });
      for (let index = 0; index < 4; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        device.send({ type: "pair_status_query", device_sid: deviceSid });
      }
      expect(device.closeInfo).toBeUndefined();
      const answer = await device.waitFor<{
        type: "pair_status_ack";
        pair_status: "waiting" | "matched";
      }>((message) => message.type === "pair_status_ack");
      expect(answer.type).toBe("pair_status_ack");
    } finally {
      await relay.close();
    }
  });

  it("每 IP 并发连接上限：超出直接拒绝升级", async () => {
    const relay = await startRelay({ maxConnectionsPerIp: 2 });
    try {
      const first = await connectClient(relay);
      const second = await connectClient(relay);
      await expect(connectClient(relay)).rejects.toThrow(/429/);
      first.close();
      second.close();
    } finally {
      await relay.close();
    }
  });

  it("每 IP 注册速率上限：超出的注册被拒（AUTH_FAILED，不无限重试）", async () => {
    const relay = await startRelay({ registrationsPerMinutePerIp: 1 });
    try {
      const { client, deviceSid } = await registerDevice(relay);
      expect(deviceSid).toBeTruthy();
      const again = await connectClient(relay);
      again.send({
        type: "device_register_init",
        device_mid: "device-mid-2",
        pass_hash: "dGVzdF9oYXNo",
        meta: DEVICE_META,
      });
      const error = await again.waitForErrorCode("AUTH_FAILED");
      expect(error.message).toBe("registration-rate-limited");
      client.close();
    } finally {
      await relay.close();
    }
  });

  it("房间数上限：注册超限被拒", async () => {
    const relay = await startRelay({ maxRooms: 1 });
    try {
      const { client: first } = await registerDevice(relay);
      const second = await connectClient(relay);
      second.send({
        type: "device_register_init",
        device_mid: "device-mid-2",
        pass_hash: "dGVzdF9oYXNo",
        meta: DEVICE_META,
      });
      const error = await second.waitForErrorCode("AUTH_FAILED");
      expect(error.message).toBe("relay-capacity");
      first.close();
    } finally {
      await relay.close();
    }
  });

  it("Origin 允许列表：不相干的 Origin 在升级阶段被拒，无 Origin 的桌面放行", async () => {
    const relay = await startRelay({ allowedOrigins: ["https://remote.example"] });
    try {
      const device = await connectClient(relay);
      expect(device.socket.readyState).toBe(WebSocket.OPEN);
      device.close();

      const allowed = await connectClient(relay, { origin: "https://remote.example" });
      expect(allowed.socket.readyState).toBe(WebSocket.OPEN);
      allowed.close();

      await expect(connectClient(relay, { origin: "https://evil.example" })).rejects.toThrow(/403/);
    } finally {
      await relay.close();
    }
  });
});

describe("relay 错误码形状", () => {
  it("error 消息带 code/message/server_ts，便于客户端分支", async () => {
    const relay = await startRelay();
    try {
      const client = await connectClient(relay);
      client.send({ type: "pair_status_query", device_sid: "nobody" });
      const error = await client.waitForErrorCode("WRONG_PARAM");
      expect(Object.keys(error).sort()).toEqual(["code", "message", "server_ts", "type"]);
      expect(typeof error.server_ts).toBe("number");
    } finally {
      await relay.close();
    }
  });
});
