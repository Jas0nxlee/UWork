import { useCallback } from "react";
import type { IImService } from "@zcode/services";
import type { ImMessage } from "@zcode/shared";
import { logger } from "@/logger.js";

/**
 * 一条消息上的三类动作：表情、置顶、编辑（收藏由外层持有集合，直接传下去）。
 *
 * 收在这里的原因：它们都是"**点一下 → 调服务端 → 刷新相关状态**"，各自带一点失败处理，
 * 散在面板里会让面板同时管交互、状态与错误。导航类动作（跳转/滚动）不在这里——
 * 那些要碰 DOM，属于面板自己的事。
 */
export function useImMessageActions(options: {
  service: IImService | null;
  conversationId: string | null;
  onPinnedChanged: () => void;
  onStartEdit: (message: ImMessage) => void;
}): {
  toggleReaction: (message: ImMessage, emoji: string, mine: boolean) => void;
  togglePin: (message: ImMessage, pinned: boolean) => void;
  startEdit: (message: ImMessage) => void;
} {
  const { service, conversationId, onPinnedChanged, onStartEdit } = options;

  const toggleReaction = useCallback(
    (message: ImMessage, emoji: string, mine: boolean): void => {
      if (!service || !conversationId) return;
      const action = mine
        ? service.removeReaction({ conversationId, messageId: message.id, emoji })
        : service.addReaction({ conversationId, messageId: message.id, emoji });
      void action.catch((error: unknown) => logger.warn("[im] 表情操作失败", error));
    },
    [service, conversationId],
  );

  const togglePin = useCallback(
    (message: ImMessage, pinned: boolean): void => {
      if (!service || !conversationId) return;
      void service
        .setMessagePinned({ conversationId, messageId: message.id, pinned })
        .then(() => onPinnedChanged())
        .catch((error: unknown) => logger.warn("[im] 置顶失败", error));
    },
    [service, conversationId, onPinnedChanged],
  );

  return { toggleReaction, togglePin, startEdit: onStartEdit };
}
