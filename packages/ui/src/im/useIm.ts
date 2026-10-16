import { useCallback, useEffect, useState } from "react";
import type { IImService, ImRealtimeEvent, ImView } from "@zcode/services";
import type { ImMessage } from "@zcode/shared";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

/**
 * IM 面板的 UI 绑定：订阅 Host 事件、提交权威视图，组件不自己算未读。
 * 与 useUcasGateway 同一套模式（先订阅、再取初值、卸载时 dispose）。
 */
export interface ImController {
  /** 当前 Host 是否注册了 IM 服务（Web/旧 host 可能没有）。 */
  available: boolean;
  loaded: boolean;
  view: ImView | null;
  service: IImService | null;
  refresh(): Promise<void>;
}

export function useIm(): ImController {
  // IM 是设备级事实（与身份同源），必须读 base host；远端 workspace 的 ServiceProvider
  // 会把服务换成远端代理，面板就会指向另一个人的会话。
  const services = useOptionalBaseWorkspaceServices();
  const service = services?.imService ?? null;
  const [view, setView] = useState<ImView | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!service) {
      setView(null);
      setLoaded(true);
      return;
    }
    let active = true;
    const apply = (candidate: unknown): void => {
      if (!active) return;
      setView(candidate as ImView);
      setLoaded(true);
    };
    const subscription = service.onDidChange(apply);
    void service
      .getView()
      .then(apply)
      .catch((error: unknown) => {
        logger.warn("[im] 读取 IM 视图失败", error);
      });
    return () => {
      active = false;
      subscription.dispose();
    };
  }, [service]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!service) return;
    const next = await service.refresh();
    setView(next);
    setLoaded(true);
  }, [service]);

  // 进入面板时刷新一次：拉会话列表并建立连接（服务内部对已连接的情况是幂等的）。
  useEffect(() => {
    if (!service) return;
    void refresh().catch((error: unknown) => {
      logger.warn("[im] 刷新 IM 会话失败", error);
    });
  }, [service, refresh]);

  return { available: Boolean(service), loaded, view, service, refresh };
}

export interface ImConversationController {
  messages: ImMessage[];
  loaded: boolean;
  sending: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  send(body: string): Promise<boolean>;
  loadOlder(): Promise<void>;
}

function mergeMessages(current: ImMessage[], incoming: ImMessage[]): ImMessage[] {
  const bySeq = new Map<number, ImMessage>();
  for (const message of current) bySeq.set(message.seq, message);
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** 单个会话的消息视图：打开即拉最新一页并上报已读，之后靠实时事件追加。 */
export function useImConversation(
  service: IImService | null,
  conversationId: string | null,
): ImConversationController {
  const [messages, setMessages] = useState<ImMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (!service || !conversationId) {
      setMessages([]);
      setLoaded(false);
      return;
    }
    let active = true;
    setLoaded(false);
    void service
      .openConversation(conversationId)
      .then((result) => {
        if (!active) return;
        setMessages(result.messages);
        setHasMore(result.hasMore);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        logger.warn("[im] 打开会话失败", error);
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [service, conversationId]);

  useEffect(() => {
    if (!service || !conversationId) return;
    const subscription = service.onRealtime((event) => {
      const realtime = event as ImRealtimeEvent;
      if (realtime.conversationId !== conversationId) return;
      if (realtime.kind === "message") {
        setMessages((current) => mergeMessages(current, [realtime.message]));
        return;
      }
      if (realtime.kind === "catch_up") {
        // 补洞拉回的历史消息：静默插入，不触发任何提醒。
        setMessages((current) => mergeMessages(current, realtime.messages));
        return;
      }
      if (realtime.kind === "message_deleted") {
        setMessages((current) =>
          current.map((message) =>
            message.id === realtime.messageId
              ? { ...message, body: "", deletedAt: Date.now() }
              : message,
          ),
        );
      }
    });
    return () => subscription.dispose();
  }, [service, conversationId]);

  const send = useCallback(
    async (body: string): Promise<boolean> => {
      if (!service || !conversationId) return false;
      const trimmed = body.trim();
      if (!trimmed) return false;
      setSending(true);
      try {
        const message = await service.sendMessage({ conversationId, body: trimmed });
        setMessages((current) => mergeMessages(current, [message]));
        return true;
      } catch (error) {
        logger.warn("[im] 发送消息失败", error);
        return false;
      } finally {
        setSending(false);
      }
    },
    [service, conversationId],
  );

  const loadOlder = useCallback(async (): Promise<void> => {
    if (!service || !conversationId) return;
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const page = await service.loadOlder(conversationId, oldest.seq);
      setMessages((current) => mergeMessages(current, page.messages));
      setHasMore(page.hasMore);
    } catch (error) {
      logger.warn("[im] 加载更早消息失败", error);
    } finally {
      setLoadingOlder(false);
    }
  }, [service, conversationId, messages]);

  return { messages, loaded, sending, loadingOlder, hasMore, send, loadOlder };
}
