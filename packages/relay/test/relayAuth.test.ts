import { describe, expect, it } from "vitest";
import {
  WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS,
  type WebRemoteControlRelayError,
  type WebRemoteControlRelayIncomingMessage,
} from "@zcode/shared";
import { calculateRelayAuthProof, verifyRelayAuthProof } from "../src/auth.js";
import { connectClient, registerDevice, startRelay } from "./helpers/relayHarness.js";

describe("relay auth proof", () => {
  it("与 shared 的测试向量逐字节一致（两侧实现的交叉验证）", () => {
    for (const vector of WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS) {
      const computed = calculateRelayAuthProof({
        passHash: vector.passHash,
        nonce: vector.nonce,
        role: vector.role,
        deviceSid: vector.deviceSid,
      });
      expect(computed).toBe(vector.proof);
      expect(
        verifyRelayAuthProof({
          passHash: vector.passHash,
          nonce: vector.nonce,
          role: vector.role,
          deviceSid: vector.deviceSid,
          proof: vector.proof,
        }),
      ).toBe(true);
    }
  });

  it("换个 nonce / sid / role / pass_hash 都验不过", () => {
    const vector = WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS[0]!;
    const base = {
      passHash: vector.passHash,
      nonce: vector.nonce,
      role: vector.role,
      deviceSid: vector.deviceSid,
      proof: vector.proof,
    };
    expect(verifyRelayAuthProof({ ...base, nonce: "nonce-2" })).toBe(false);
    expect(verifyRelayAuthProof({ ...base, deviceSid: "device-2" })).toBe(false);
    expect(verifyRelayAuthProof({ ...base, passHash: "dGVzdF9oYXNoMg" })).toBe(false);
    expect(verifyRelayAuthProof({ ...base, proof: "not-a-proof" })).toBe(false);
  });
});

function errorOf(message: WebRemoteControlRelayIncomingMessage | undefined): string | undefined {
  return message?.type === "error" ? (message as WebRemoteControlRelayError).code : undefined;
}

describe("relay 鉴权失败面", () => {
  it("device 用未知 sid 鉴权 → AUTH_FAILED（桌面会重新注册）", async () => {
    const relay = await startRelay();
    try {
      const client = await connectClient(relay);
      client.send({
        type: "auth_init",
        role: "device",
        device_sid: "ghost-sid",
        meta: { platform: "darwin", version: "test", name: "desktop" },
      });
      const error = await client.waitForErrorCode("AUTH_FAILED");
      expect(error.message).toBe("unknown-device-sid");
      await client.closed;
    } finally {
      await relay.close();
    }
  });

  it("terminal 用未知 sid 鉴权 → DEVICE_OFFLINE（手机走宽限窗口，不是终态失败）", async () => {
    const relay = await startRelay();
    try {
      const client = await connectClient(relay);
      client.send({
        type: "auth_init",
        role: "terminal",
        device_sid: "ghost-sid",
        meta: { platform: "web", version: "test", name: "mobile-browser" },
      });
      const error = await client.waitForErrorCode("DEVICE_OFFLINE");
      expect(error.message).toBe("unknown-device-sid");
      // DEVICE_OFFLINE 是可恢复信号：relay 不主动断开，由客户端自己重连。
      expect(client.closeInfo).toBeUndefined();
    } finally {
      await relay.close();
    }
  });

  it("proof 错误 → AUTH_FAILED，且 nonce 作废（重放同一 proof 也过不了）", async () => {
    const relay = await startRelay();
    try {
      const { client, deviceSid, passHash } = await registerDevice(relay);
      client.send({
        type: "auth_init",
        role: "device",
        device_sid: deviceSid,
        meta: { platform: "darwin", version: "test", name: "desktop" },
      });
      const challenge = await client.waitFor<{ type: "auth_challenge"; nonce: string }>(
        (message) => message.type === "auth_challenge",
      );
      const goodProof = calculateRelayAuthProof({
        passHash,
        nonce: challenge.nonce,
        role: "device",
        deviceSid,
      });
      client.send({ type: "auth_response", device_sid: deviceSid, proof: `${goodProof}x` });
      const error = await client.waitForErrorCode("AUTH_FAILED");
      expect(error.message).toBe("auth-proof-invalid");
      // 连接已被拒绝：再用正确 proof 重放也拿不到新的 challenge，只能重新 auth_init。
      await client.closed;
    } finally {
      await relay.close();
    }
  });

  it("超过尝试上限后即使 proof 正确也拒绝", async () => {
    const relay = await startRelay();
    try {
      const { client, deviceSid } = await registerDevice(relay);
      client.send({
        type: "auth_init",
        role: "device",
        device_sid: deviceSid,
        meta: { platform: "darwin", version: "test", name: "desktop" },
      });
      await client.waitFor((message) => message.type === "auth_challenge");
      client.send({ type: "auth_response", device_sid: deviceSid, proof: "bad-1" });
      const error = await client.waitForErrorCode("AUTH_FAILED");
      expect(error.message).toBe("auth-proof-invalid");
      await client.closed;
    } finally {
      await relay.close();
    }
  });

  it("未 auth_init 就发 auth_response → WRONG_PARAM", async () => {
    const relay = await startRelay();
    try {
      const client = await connectClient(relay);
      client.send({ type: "auth_response", device_sid: "whatever", proof: "nope" });
      const error = await client.waitForErrorCode("WRONG_PARAM");
      expect(error.message).toBe("auth_response-before-auth_init");
    } finally {
      await relay.close();
    }
  });

  it("错误角色（device 会用 terminal 的 proof）过不了：proof 绑定 role", async () => {
    const relay = await startRelay();
    try {
      const { client, deviceSid, passHash } = await registerDevice(relay);
      client.send({
        type: "auth_init",
        role: "device",
        device_sid: deviceSid,
        meta: { platform: "darwin", version: "test", name: "desktop" },
      });
      const challenge = await client.waitFor<{ type: "auth_challenge"; nonce: string }>(
        (message) => message.type === "auth_challenge",
      );
      client.send({
        type: "auth_response",
        device_sid: deviceSid,
        proof: calculateRelayAuthProof({
          passHash,
          nonce: challenge.nonce,
          role: "terminal",
          deviceSid,
        }),
      });
      expect(errorOf(await client.waitForErrorCode("AUTH_FAILED"))).toBe("AUTH_FAILED");
    } finally {
      await relay.close();
    }
  });
});
