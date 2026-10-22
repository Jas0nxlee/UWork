import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebRemoteControlRelayRole } from "@zcode/shared";

/**
 * proof = base64url(HMAC-SHA256(key = pass_hash, message = "nonce|role|device_sid"))。
 * 与桌面端 `createNodeWebRemoteControlRelayAuthProvider`、shared 的
 * `WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS` 必须逐字节一致；三条实现互为交叉验证。
 */
export function calculateRelayAuthProof(params: {
  passHash: string;
  nonce: string;
  role: WebRemoteControlRelayRole;
  deviceSid: string;
}): string {
  return createHmac("sha256", params.passHash)
    .update(`${params.nonce}|${params.role}|${params.deviceSid}`)
    .digest("base64url");
}

export function createRelayAuthNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function createRelayDeviceSid(): string {
  return randomBytes(18).toString("base64url");
}

function safeEqualBase64Url(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

export function verifyRelayAuthProof(params: {
  passHash: string;
  nonce: string;
  role: WebRemoteControlRelayRole;
  deviceSid: string;
  proof: string;
}): boolean {
  const expected = calculateRelayAuthProof(params);
  return safeEqualBase64Url(expected, params.proof);
}
