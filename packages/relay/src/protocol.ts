import type { WebRemoteControlRelayDeviceMeta, WebRemoteControlRelayRole } from "@zcode/shared";

/**
 * 只做形状校验：relay 不解释业务 payload，所以 `data.payload` 保持 unknown 原样透传。
 * 校验失败的语义见 spec 第二节（未鉴权阶段 WRONG_PARAM，已鉴权后丢帧记日志）。
 */
export type ParsedRelayClientMessage =
  | { kind: "invalid"; reason: string }
  | {
      kind: "device_register_init";
      deviceMid: string;
      passHash: string;
      meta: WebRemoteControlRelayDeviceMeta;
    }
  | {
      kind: "auth_init";
      role: WebRemoteControlRelayRole;
      deviceSid: string;
      meta: WebRemoteControlRelayDeviceMeta;
    }
  | { kind: "auth_response"; deviceSid: string; proof: string }
  | { kind: "pair_status_query"; deviceSid: string }
  | { kind: "data"; payload: unknown };

function readNonEmptyString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readMeta(source: Record<string, unknown>): WebRemoteControlRelayDeviceMeta | undefined {
  const meta = source["meta"];
  if (!meta || typeof meta !== "object") return undefined;
  const record = meta as Record<string, unknown>;
  const platform = readNonEmptyString(record, "platform");
  const version = readNonEmptyString(record, "version");
  const name = readNonEmptyString(record, "name");
  if (!platform || !version || !name) return undefined;
  return { platform, version, name };
}

function readRole(source: Record<string, unknown>): WebRemoteControlRelayRole | undefined {
  const role = readNonEmptyString(source, "role");
  return role === "device" || role === "terminal" ? role : undefined;
}

export function parseRelayClientMessage(raw: string): ParsedRelayClientMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "malformed-json" };
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return { kind: "invalid", reason: "not-an-object" };
  }
  const record = decoded as Record<string, unknown>;
  const type = readNonEmptyString(record, "type");
  if (!type) return { kind: "invalid", reason: "missing-type" };

  switch (type) {
    case "device_register_init": {
      const deviceMid = readNonEmptyString(record, "device_mid");
      const passHash = readNonEmptyString(record, "pass_hash");
      const meta = readMeta(record);
      if (!deviceMid || !passHash || !meta) {
        return { kind: "invalid", reason: "device_register_init-fields" };
      }
      return { kind: "device_register_init", deviceMid, passHash, meta };
    }
    case "auth_init": {
      const role = readRole(record);
      const deviceSid = readNonEmptyString(record, "device_sid");
      const meta = readMeta(record);
      if (!role || !deviceSid || !meta) {
        return { kind: "invalid", reason: "auth_init-fields" };
      }
      return { kind: "auth_init", role, deviceSid, meta };
    }
    case "auth_response": {
      const deviceSid = readNonEmptyString(record, "device_sid");
      const proof = readNonEmptyString(record, "proof");
      if (!deviceSid || !proof) {
        return { kind: "invalid", reason: "auth_response-fields" };
      }
      return { kind: "auth_response", deviceSid, proof };
    }
    case "pair_status_query": {
      const deviceSid = readNonEmptyString(record, "device_sid");
      if (!deviceSid) return { kind: "invalid", reason: "pair_status_query-fields" };
      return { kind: "pair_status_query", deviceSid };
    }
    case "data": {
      if (!("payload" in record)) {
        return { kind: "invalid", reason: "data-payload-missing" };
      }
      return { kind: "data", payload: record["payload"] };
    }
    default:
      return { kind: "invalid", reason: `unknown-type:${type}` };
  }
}
