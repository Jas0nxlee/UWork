import { useCallback, useEffect, useState, type RefObject } from "react";
import type { ImMessage } from "@zcode/shared";

/** 跳转请求（右栏置顶 / 收藏 / 全局检索命中）：seq 是会话内坐标，换会话后靠它拉上下文。 */
export interface ImJumpRequest {
  conversationId: string;
  id: string;
  seq: number;
  at: number;
}

/**
 * "跳到某条消息"：加载上下文 + 滚动 + 高亮。
 *
 * 抽出来的理由：这套逻辑和面板的渲染无关，但和三件事绑得很细——时间线的 DOM 在面板里
 * （滚动要量它的位置）、检索面板要收起、跨会话命中要交给外层切换。
 * 三者都以参数形式进来，剩下的就只是"滚过去并亮 2.5 秒"。
 */
export function useImJumpToMessage(options: {
  /** 消息列表面板的根节点：用来量目标是否真的落在可视区内。 */
  rootRef: RefObject<HTMLDivElement | null>;
  conversationId: string;
  messages: ImMessage[];
  /** 拉某条消息前后的上下文窗口（窗口大小由 hook 里的实现决定，见 useIm）。 */
  loadAround: (seq: number) => Promise<unknown>;
  /** 命中在别的会话：交给外层切会话并带 seq 跳。 */
  onOpenConversation?: (conversationId: string, messageId: string, seq: number) => void;
  /** 跳之前收起检索面板（面板自己知道怎么收）。 */
  onBeforeJump?: () => void;
  /** 由外层传进来的跳转请求（右栏点置顶/收藏）。 */
  jumpRequest?: ImJumpRequest | null;
}): {
  jumpTarget: string | null;
  jumpToMessage: (messageId: string) => void;
  openSearchHit: (message: ImMessage) => void;
} {
  const { conversationId, messages, rootRef } = options;
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);

  /**
   * 滚动到某条消息，并**测量后纠正**。
   *
   * 为什么要纠正：StickToBottom 在内容变高时会贴底，而"跳转"往往同时带来内容变化
   * （命中不在窗口里 → 先加载上下文），它那次贴底会把我们的 scrollIntoView 盖掉，
   * 结果"高亮了但没在视口里"。这里滚完量一次位置，不对就再来一次（最多三轮）。
   */
  const scrollToMessage = useCallback(
    (messageId: string): void => {
      let attempts = 0;
      const run = (): void => {
        attempts += 1;
        const container = rootRef.current;
        const target = container?.querySelector<HTMLElement>(`[data-im-message-id="${messageId}"]`);
        if (!container || !target) return; // 目标不在已加载的窗口里：不假装跳过去了
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const outside =
          targetRect.bottom < containerRect.top || targetRect.top > containerRect.bottom;
        if (outside || attempts === 1) {
          target.scrollIntoView({ block: "center" });
        }
        if (outside && attempts < 3) window.setTimeout(run, 120);
      };
      run();
    },
    [rootRef],
  );

  /**
   * 跳转（引用 / 检索命中）：滚动 + 高亮。
   * 高亮给 2.5 秒——跳进很久以前的历史时，1 秒多不够看清自己落在哪一条。
   */
  const jumpToMessage = useCallback(
    (messageId: string): void => {
      setJumpTarget(messageId);
      scrollToMessage(messageId);
      window.setTimeout(
        () => setJumpTarget((current) => (current === messageId ? null : current)),
        2500,
      );
    },
    [scrollToMessage],
  );

  // 右栏点置顶/收藏 → 滚过去并高亮（时间线 DOM 在面板里）
  useEffect(() => {
    if (!options.jumpRequest) return;
    if (messages.some((message) => message.id === options.jumpRequest?.id)) {
      jumpToMessage(options.jumpRequest.id);
      return;
    }
    // 目标不在已加载的窗口里：按它的 seq 拉一段上下文再跳（seq 是会话内坐标，必须带上）
    void options
      .loadAround(options.jumpRequest.seq)
      .then(() => window.setTimeout(() => jumpToMessage(options.jumpRequest?.id ?? ""), 60))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.jumpRequest?.at]);

  /**
   * 跳到某条检索命中：那条通常不在已加载的窗口里，先按 seq 拉它前后的上下文再滚动。
   * 已经在窗口里的就直接滚（省一次往返）。
   */
  const openSearchHit = useCallback(
    (message: ImMessage): void => {
      options.onBeforeJump?.();
      // 全局检索的命中可能在别的会话：交给外层切会话 + 带 seq 跳转
      if (message.conversationId !== conversationId) {
        options.onOpenConversation?.(message.conversationId, message.id, message.seq);
        return;
      }
      if (messages.some((item) => item.id === message.id)) {
        jumpToMessage(message.id);
        return;
      }
      void options
        .loadAround(message.seq)
        .then(() => window.setTimeout(() => jumpToMessage(message.id), 60));
    },
    [conversationId, messages, jumpToMessage, options],
  );

  return { jumpTarget, jumpToMessage, openSearchHit };
}
