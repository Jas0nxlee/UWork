import { describe, expect, it } from "vitest";
import {
  authenticate,
  connectClient,
  pairDeviceAndTerminal,
  registerDevice,
  startRelay,
} from "./helpers/relayHarness.js";

describe("relay 配对主流程", () => {
  it("注册 → 双侧鉴权 → matched，并给先在线的一端推状态变化", async () => {
    const relay = await startRelay();
    try {
      const { client: device, deviceSid, passHash } = await registerDevice(relay);
      await authenticate(device, { role: "device", deviceSid, passHash });
      const deviceAck = await device.waitFor<{ type: "auth_ack"; pair_status: string }>(
        (message) => message.type === "auth_ack",
      );
      // 桌面先连上、手机还没扫码：waiting。
      expect(deviceAck.pair_status).toBe("waiting");

      const terminal = await connectClient(relay);
      await authenticate(terminal, { role: "terminal", deviceSid, passHash });
      const terminalAck = await terminal.waitFor<{ type: "auth_ack"; pair_status: string }>(
        (message) => message.type === "auth_ack",
      );
      expect(terminalAck.pair_status).toBe("matched");

      // 手机上线后，桌面不必等心跳就能收到 matched 推送。
      const pushed = await device.waitFor<{ type: "pair_status_ack"; pair_status: string }>(
        (message) => message.type === "pair_status_ack" && message.pair_status === "matched",
      );
      expect(pushed.pair_status).toBe("matched");
    } finally {
      await relay.close();
    }
  });

  it("matched 后双向透传 data，payload 原样不变", async () => {
    const relay = await startRelay();
    try {
      const { device, terminal } = await pairDeviceAndTerminal(relay);
      const payloadFromTerminal = { zcode_type: "rpc-frame", seq: 1, nested: { text: "你好" } };
      terminal.send({ type: "data", payload: payloadFromTerminal });
      const receivedByDevice = await device.waitFor<{ type: "data"; payload: unknown }>(
        (message) => message.type === "data",
      );
      expect(receivedByDevice.payload).toEqual(payloadFromTerminal);

      const payloadFromDevice = { zcode_type: "rpc-frame", seq: 2, dataBase64: "AAEC" };
      device.send({ type: "data", payload: payloadFromDevice });
      const receivedByTerminal = await terminal.waitFor<{ type: "data"; payload: unknown }>(
        (message) => message.type === "data",
      );
      expect(receivedByTerminal.payload).toEqual(payloadFromDevice);
    } finally {
      await relay.close();
    }
  });

  it("pair_status_query 如实回答，并带上 terminal_sid", async () => {
    const relay = await startRelay();
    try {
      const { device, terminal, deviceSid } = await pairDeviceAndTerminal(relay);
      device.send({ type: "pair_status_query", device_sid: deviceSid });
      const answer = await device.waitFor<{
        type: "pair_status_ack";
        pair_status: string;
        terminal_sid?: string;
      }>((message) => message.type === "pair_status_ack");
      expect(answer.pair_status).toBe("matched");
      expect(typeof answer.terminal_sid).toBe("string");
      // 手机侧同样能查（心跳两侧都发）。
      terminal.send({ type: "pair_status_query", device_sid: deviceSid });
      await terminal.waitFor(
        (message) => message.type === "pair_status_ack" && message.pair_status === "matched",
      );
    } finally {
      await relay.close();
    }
  });

  it("桌面掉线 → 手机收 DEVICE_OFFLINE，之后查询状态是 waiting", async () => {
    const relay = await startRelay();
    try {
      const { device, terminal, deviceSid } = await pairDeviceAndTerminal(relay);
      device.close();
      const offline = await terminal.waitForErrorCode("DEVICE_OFFLINE");
      expect(offline.message).toBe("device-disconnected");

      terminal.send({ type: "pair_status_query", device_sid: deviceSid });
      const answer = await terminal.waitFor<{ type: "pair_status_ack"; pair_status: string }>(
        (message) => message.type === "pair_status_ack",
      );
      expect(answer.pair_status).toBe("waiting");
    } finally {
      await relay.close();
    }
  });

  it("手机掉线 → 桌面只收到 waiting 状态，不收到错误", async () => {
    const relay = await startRelay();
    try {
      const { device, terminal } = await pairDeviceAndTerminal(relay);
      terminal.close();
      const waiting = await device.waitFor<{ type: "pair_status_ack"; pair_status: string }>(
        (message) => message.type === "pair_status_ack" && message.pair_status === "waiting",
      );
      expect(waiting.pair_status).toBe("waiting");
      expect(device.errors).toHaveLength(0);
    } finally {
      await relay.close();
    }
  });

  it("第二个手机连同一 sid → 先到的被 KICKED（一条链接只能一台手机）", async () => {
    const relay = await startRelay();
    try {
      const { device, terminal, deviceSid, passHash } = await pairDeviceAndTerminal(relay);
      const secondTerminal = await connectClient(relay);
      await authenticate(secondTerminal, { role: "terminal", deviceSid, passHash });

      const kicked = await terminal.waitForErrorCode("KICKED");
      expect(kicked.message).toBe("replaced-by-newer-terminal");
      await terminal.closed;

      // 后到的手机接管配对，桌面收到的是 matched（不是掉线）。
      const secondAck = await secondTerminal.waitFor<{ type: "auth_ack"; pair_status: string }>(
        (message) => message.type === "auth_ack",
      );
      expect(secondAck.pair_status).toBe("matched");
      expect(device.errors).toHaveLength(0);
    } finally {
      await relay.close();
    }
  });

  it("桌面重连带同一个 sid（persisted）→ 重新 matched，旧二维码不作废", async () => {
    const relay = await startRelay();
    try {
      const { terminal, deviceSid, passHash } = await pairDeviceAndTerminal(relay);
      const reconnected = await connectClient(relay);
      // 不注册、直接拿旧 sid + 旧 pass_hash 鉴权：这正是桌面重启后自动恢复远控的路径。
      await authenticate(reconnected, { role: "device", deviceSid, passHash });
      const ack = await reconnected.waitFor<{ type: "auth_ack"; pair_status: string }>(
        (message) => message.type === "auth_ack",
      );
      expect(ack.pair_status).toBe("matched");
      await terminal.waitFor(
        (message) => message.type === "pair_status_ack" && message.pair_status === "matched",
      );
    } finally {
      await relay.close();
    }
  });

  it("手机在桌面不在线时鉴权（sid 有效）→ 先给 waiting，再推 DEVICE_OFFLINE", async () => {
    const relay = await startRelay();
    try {
      const { client: device, deviceSid, passHash } = await registerDevice(relay);
      await authenticate(device, { role: "device", deviceSid, passHash });
      device.close();

      const terminal = await connectClient(relay);
      await authenticate(terminal, { role: "terminal", deviceSid, passHash });
      const ack = await terminal.waitFor<{ type: "auth_ack"; pair_status: string }>(
        (message) => message.type === "auth_ack",
      );
      expect(ack.pair_status).toBe("waiting");
      // 没有 DEVICE_OFFLINE 的话手机只会等到 waiting 超时的 invalid-mobile-connection。
      const offline = await terminal.waitForErrorCode("DEVICE_OFFLINE");
      expect(offline.message).toBe("device-offline");
    } finally {
      await relay.close();
    }
  });
});
