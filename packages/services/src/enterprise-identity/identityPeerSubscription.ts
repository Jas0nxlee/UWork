import type { IBroadcastService } from "../broadcast/broadcast.js";

/** 广播只触发读取设备事实，不把 UI payload 当作认证资料；身份变化仍由 owner 执行。 */
export function subscribeIdentityPeerChanges(options: {
  broadcast?: Pick<IBroadcastService, "onMessage">;
  isDisposed(): boolean;
  readRevision(): Promise<number>;
  knownRevision(): number;
  synchronize(): Promise<void>;
  onFailure(): void;
}) {
  return options.broadcast?.onMessage((message) => {
    if (options.isDisposed() || message.channel !== "state:enterprise-identity") return;
    void (async () => {
      const revision = await options.readRevision();
      if (options.isDisposed() || revision <= options.knownRevision()) return;
      await options.synchronize();
    })().catch(options.onFailure);
  });
}
