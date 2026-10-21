import type { WebRemoteControlAppPayload, WebRemoteControlRelayDeviceMeta } from "@zcode/shared";
import type { WebRemoteControlRelayAuthProvider } from "./hmacIdentity.js";
export type WebRemoteControlHmacDeviceTransportState =
  | "idle"
  | "connecting"
  | "registering"
  | "authenticating"
  | "waiting_terminal"
  | "paired"
  | "kicked"
  | "error";

export type WebRemoteControlHmacDeviceTransportAuth =
  | {
      mode: "register";
      passHash: string;
    }
  | {
      mode: "persisted";
      deviceSid: string;
      passHash: string;
    };

export interface WebRemoteControlHmacDeviceTransportOptions {
  relayWsUrl: string;
  deviceMid: string;
  auth: WebRemoteControlHmacDeviceTransportAuth;
  meta: WebRemoteControlRelayDeviceMeta;
  authProvider: WebRemoteControlRelayAuthProvider;
  heartbeatIntervalMs?: number;
  heartbeatJitterMs?: number;
  heartbeatAckTimeoutMs?: number;
  reconnectJitterMs?: number;
  reconnectDelayMs?: number;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  relayMessageLogger?: {
    info: (...args: unknown[]) => void;
  };
  onRegisteredAuth(auth: { deviceSid: string; passHash: string }): void;
  onStateChange(state: WebRemoteControlHmacDeviceTransportState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onError(error: Error): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
  onInvalidPersistedAuth(): Promise<void>;
}
