import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WebRemoteControlRelayDeviceMeta } from "@zcode/shared";
import { createRelayDeviceSid } from "./auth.js";
import { createRelayLogger, type RelayLogger } from "./logging.js";

export interface RelayDeviceRecord {
  deviceSid: string;
  passHash: string;
  deviceMid: string;
  meta: WebRemoteControlRelayDeviceMeta;
  registeredAt: number;
  lastSeenAt: number;
}

interface RelayStateSnapshot {
  version: 1;
  devices: Record<string, RelayDeviceRecord>;
}

export interface RelayDeviceStoreOptions {
  stateFile?: string;
  flushIntervalMs?: number;
  now?: () => number;
  logger?: RelayLogger;
}

function isDeviceRecord(value: unknown): value is RelayDeviceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["deviceSid"] === "string" &&
    typeof record["passHash"] === "string" &&
    typeof record["deviceMid"] === "string" &&
    typeof record["registeredAt"] === "number"
  );
}

/**
 * 凭证存储：落盘是「relay 重启后旧二维码仍可用」的硬要求（spec 第六节）。
 * 只存 sid → pass_hash 与设备元数据，永远不存 payload。
 */
export class RelayDeviceStore {
  private readonly devices = new Map<string, RelayDeviceRecord>();
  private readonly stateFile?: string;
  private readonly flushIntervalMs: number;
  private readonly now: () => number;
  private readonly logger: RelayLogger;
  private flushTimer?: NodeJS.Timeout;
  private flushInFlight = false;
  private dirty = false;

  constructor(options: RelayDeviceStoreOptions = {}) {
    this.stateFile = options.stateFile;
    this.flushIntervalMs = options.flushIntervalMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? createRelayLogger();
  }

  loadSync(): void {
    if (!this.stateFile) return;
    try {
      const snapshot = JSON.parse(readFileSync(this.stateFile, "utf8")) as RelayStateSnapshot;
      for (const record of Object.values(snapshot.devices ?? {})) {
        if (isDeviceRecord(record)) {
          this.devices.set(record.deviceSid, record);
        }
      }
      this.logger.info("restored relay state", { devices: this.devices.size });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.logger.info("relay state file not found, starting empty", {
          stateFile: this.stateFile,
        });
        return;
      }
      // 状态文件损坏时不能带病启动：旧二维码失效是可接受的，静默丢凭证会让用户无法解释。
      throw new Error(`relay 状态文件无法读取: ${this.stateFile} (${String(error)})`);
    }
  }

  register(params: {
    deviceMid: string;
    passHash: string;
    meta: WebRemoteControlRelayDeviceMeta;
  }): RelayDeviceRecord {
    const timestamp = this.now();
    const record: RelayDeviceRecord = {
      deviceSid: createRelayDeviceSid(),
      passHash: params.passHash,
      deviceMid: params.deviceMid,
      meta: params.meta,
      registeredAt: timestamp,
      lastSeenAt: timestamp,
    };
    this.devices.set(record.deviceSid, record);
    this.markDirty();
    return record;
  }

  get(deviceSid: string): RelayDeviceRecord | undefined {
    return this.devices.get(deviceSid);
  }

  touch(deviceSid: string): void {
    const record = this.devices.get(deviceSid);
    if (!record) return;
    record.lastSeenAt = this.now();
    this.markDirty();
  }

  size(): number {
    return this.devices.size;
  }

  /** 运维用：清掉长期未活动的凭证（默认不自动清理，避免静默废掉用户手里的二维码）。 */
  pruneIdleOlderThan(maxIdleMs: number): number {
    const threshold = this.now() - maxIdleMs;
    let removed = 0;
    for (const [deviceSid, record] of this.devices) {
      if (record.lastSeenAt < threshold) {
        this.devices.delete(deviceSid);
        removed += 1;
      }
    }
    if (removed > 0) this.markDirty();
    return removed;
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.stateFile || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (!this.stateFile || !this.dirty || this.flushInFlight) return;
    this.flushInFlight = true;
    const snapshot: RelayStateSnapshot = {
      version: 1,
      devices: Object.fromEntries(this.devices),
    };
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const temporaryPath = `${this.stateFile}.tmp`;
      writeFileSync(temporaryPath, JSON.stringify(snapshot), "utf8");
      renameSync(temporaryPath, this.stateFile);
      this.dirty = false;
    } catch (error) {
      // 落盘失败必须显式暴露：静默失败等于「重启后所有二维码失效」。
      this.logger.error("relay state flush failed", { message: (error as Error).message });
    } finally {
      this.flushInFlight = false;
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }
}
