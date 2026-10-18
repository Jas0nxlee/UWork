import { useCallback, useEffect, useState } from "react";
import type { IImService } from "@zcode/services";
import type { ImMessage } from "@zcode/shared";
import { logger } from "@/logger.js";

/**
 * 会话内的置顶消息（右栏用）。
 *
 * 置顶是**会话内共享**的状态（别人钉的我也该看到），所以：进会话拉一次、自己钉/取消钉之后重拉；
 * 别人钉的时候由实时 `message_updated` 触发重拉（见 hook 里的订阅）。
 */
export function useImPinnedMessages(
  service: IImService | null,
  conversationId: string | null,
): { pinned: ImMessage[]; refresh: () => void } {
  const [pinned, setPinned] = useState<ImMessage[]>([]);

  const refresh = useCallback((): void => {
    if (!service || !conversationId) {
      setPinned([]);
      return;
    }
    void service
      .listPinnedMessages(conversationId)
      .then(setPinned)
      .catch((error: unknown) => logger.warn("[im] 读取置顶消息失败", error));
  }, [service, conversationId]);

  useEffect(() => {
    setPinned([]);
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!service || !conversationId) return;
    const subscription = service.onRealtime((event) => {
      const realtime = event as { kind?: string; conversationId?: string };
      // 别人钉/取消钉也会广播 message_updated：这里不必解析，重拉一次最省心（置顶条数很少）
      if (realtime.kind === "message_updated" && realtime.conversationId === conversationId) {
        refresh();
      }
    });
    return () => subscription.dispose();
  }, [service, conversationId, refresh]);

  return { pinned, refresh };
}
