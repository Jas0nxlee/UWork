import { describe, expect, it } from "vitest";
import { WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS } from "@zcode/shared";
import { RELAY_ERROR_SEMANTICS, verifyRelayAuthProof } from "./contract.js";
import { startExampleRelay } from "./contract.example.js";

describe("relay contract", () => {
  it("示例能起来并把 /health 与 ws 端点暴露出来", async () => {
    const example = await startExampleRelay();
    try {
      const health = await (await fetch(`${example.httpUrl}/health`)).json();
      expect(health).toMatchObject({ status: "ok", version: "example", rooms: 0, connections: 0 });

      const socket = new (await import("ws")).WebSocket(example.wsUrl);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      expect(socket.readyState).toBe(socket.OPEN);
      socket.close();
    } finally {
      await example.close();
    }
  });

  it("鉴权证明与 shared 向量一致（跨实现契约）", () => {
    for (const vector of WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS) {
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

  it("错误码语义覆盖 shared 的全部 code", () => {
    expect(Object.keys(RELAY_ERROR_SEMANTICS).sort()).toEqual([
      "AUTH_FAILED",
      "DEVICE_OFFLINE",
      "INTERNAL",
      "KICKED",
      "WRONG_PARAM",
    ]);
  });
});
