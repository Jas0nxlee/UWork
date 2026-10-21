import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticate,
  connectClient,
  pairDeviceAndTerminal,
  registerDevice,
  startRelay,
} from "./helpers/relayHarness.js";

const temporaryDirectories: string[] = [];

function temporaryStateFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "relay-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "relay-state.json");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("relay 凭证落盘", () => {
  it("重启后旧 device_sid + pass_hash 仍能鉴权（旧二维码不作废）", async () => {
    const stateFile = temporaryStateFile();
    const first = await startRelay({ stateFile });
    const { deviceSid, passHash } = await registerDevice(first);
    await first.close();

    const second = await startRelay({ stateFile });
    try {
      const client = await connectClient(second);
      await authenticate(client, { role: "device", deviceSid, passHash });
      const ack = await client.waitFor<{ type: "auth_ack"; device_sid: string }>(
        (message) => message.type === "auth_ack",
      );
      expect(ack.device_sid).toBe(deviceSid);
    } finally {
      await second.close();
    }
  });

  it("不配 stateFile 时重启会让旧二维码失效（内存态，仅适合本地调试）", async () => {
    const first = await startRelay();
    const { deviceSid, passHash } = await registerDevice(first);
    await first.close();

    const second = await startRelay();
    try {
      const client = await connectClient(second);
      client.send({
        type: "auth_init",
        role: "device",
        device_sid: deviceSid,
        meta: { platform: "darwin", version: "test", name: "desktop" },
      });
      const error = await client.waitForErrorCode("AUTH_FAILED");
      expect(error.message).toBe("unknown-device-sid");
      expect(passHash).toBeTruthy();
    } finally {
      await second.close();
    }
  });

  it("落盘只写凭证与元数据，不写任何 payload", async () => {
    const stateFile = temporaryStateFile();
    const relay = await startRelay({ stateFile });
    try {
      const { device, terminal } = await pairDeviceAndTerminal(relay);
      terminal.send({
        type: "data",
        payload: { zcode_type: "rpc-frame", secret: "会话内容不该落盘" },
      });
      await device.waitFor((message) => message.type === "data");
    } finally {
      await relay.close();
    }

    const persisted = readFileSync(stateFile, "utf8");
    const snapshot = JSON.parse(persisted) as {
      version: number;
      devices: Record<string, Record<string, unknown>>;
    };
    expect(snapshot.version).toBe(1);
    const records = Object.values(snapshot.devices);
    expect(records).toHaveLength(1);
    expect(Object.keys(records[0]!).sort()).toEqual([
      "deviceMid",
      "deviceSid",
      "lastSeenAt",
      "meta",
      "passHash",
      "registeredAt",
    ]);
    expect(persisted).not.toContain("会话内容不该落盘");
    expect(persisted).not.toContain("rpc-frame");
  });
});
