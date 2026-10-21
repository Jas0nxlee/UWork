import type { WebRemoteControlAppPayload, WebRemoteControlFailure } from "@zcode/shared";
export type WebRemoteControlHmacTerminalTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "reconnecting"
  | "suspended"
  | "kicked"
  | "error";

export type WebRemoteControlHmacTerminalTransportDiagnostic =
  | {
      type: "state-transition";
      previousState: WebRemoteControlHmacTerminalTransportState;
      state: WebRemoteControlHmacTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-close";
      code: number;
      reason: string;
      wasClean: boolean;
      wasPaired: boolean;
      state: WebRemoteControlHmacTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-error" | "recover-start" | "recover-scheduled";
      state: WebRemoteControlHmacTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "pair-status";
      pairStatus: "waiting" | "matched";
      state: WebRemoteControlHmacTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-extensions";
      state: WebRemoteControlHmacTerminalTransportState;
      perMessageDeflate: boolean;
      extensions?: string;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    };

export type HmacTerminalTransportDiagnosticInput = {
  type: WebRemoteControlHmacTerminalTransportDiagnostic["type"];
  previousState?: WebRemoteControlHmacTerminalTransportState;
  state: WebRemoteControlHmacTerminalTransportState;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  wasPaired?: boolean;
  pairStatus?: "waiting" | "matched";
  perMessageDeflate?: boolean;
  extensions?: string;
};

export interface WebRemoteControlHmacTerminalTransportOptions {
  relayWsUrl: string;
  deviceSid: string;
  passHash: string;
  deviceMid?: string;
  appVersion?: string;
  WebSocketCtor?: typeof globalThis.WebSocket;
  heartbeatIntervalMs?: number;
  heartbeatJitterMs?: number;
  heartbeatAckTimeoutMs?: number;
  reconnectJitterMs?: number;
  healthCheckTimeoutMs?: number;
  desktopOfflineGraceMs?: number;
  staleWaitingRecoveryMs?: number;
  waitingTimeoutMs?: number;
  authProvider: {
    calculateProof(
      passHash: string,
      nonce: string,
      role: "terminal",
      deviceSid: string,
    ): Promise<string>;
  };
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onStateChange(state: WebRemoteControlHmacTerminalTransportState): void;
  onFailure(failure: WebRemoteControlFailure): void;
  onError(error: Error): void;
  onDiagnostic?(diagnostic: WebRemoteControlHmacTerminalTransportDiagnostic): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
  reloadPage(): void;
}
