import type { WebRemoteControlRelayRole } from "@zcode/shared";
export interface WebRemoteControlRelayAuthProvider {
  createPassword(): string;
  createPassHash(password: string): string;
  calculateProof(
    passHash: string,
    nonce: string,
    role: WebRemoteControlRelayRole,
    deviceSid: string,
  ): string;
}

export interface WebRemoteControlRelayStoredAuth {
  deviceSid: string;
  passHash: string;
}

export interface WebRemoteControlRelayAuthStorageProvider {
  load(): Promise<WebRemoteControlRelayStoredAuth | undefined>;
  save(auth: WebRemoteControlRelayStoredAuth): Promise<void>;
  clear(): Promise<void>;
  rotate(auth: WebRemoteControlRelayStoredAuth): Promise<void>;
}
