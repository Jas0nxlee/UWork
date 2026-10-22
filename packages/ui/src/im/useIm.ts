import { useCallback, useEffect, useState } from "react";
import type { IImService, ImRealtimeEvent, ImView } from "./contract.js";
import type { ImMessage } from "@zcode/shared";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import {
  createOutboxItem,
  markOutboxFailed,
  markOutboxSending,
  outboxForConversation,
  reconcileOutbox,
  type ImOutboxItem,
  type ImOutboxReply,
} from "./imOutbox.js";

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
  /** 本地乐观消息（发送中/失败），按时间顺序排在真实消息之后。 */
  outbox: ImOutboxItem[];
  loaded: boolean;
  sending: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  send(body: string, replyTo?: ImOutboxReply | null, mentionIds?: string[]): Promise<boolean>;
  /** 发附件消息：body 是 `{attachmentId,name,mime,size}` 的 JSON（见 shared 的解析函数）。 */
  sendAttachment(body: string): Promise<boolean>;
  /** 重发失败的乐观消息：复用同一条的 clientMsgId，服务端按 id 去重。 */
  retry(clientMsgId: string): Promise<boolean>;
  /** 放弃发送中的乐观项（仅失败态可用，避免用户被一条发不出去的消息卡住）。 */
  discard(clientMsgId: string): void;
  /** 向上翻历史。 */
  loadOlder(): Promise<void>;
  /**
   * 跳到某条消息（检索命中/引用跳转）：拉它前后的上下文窗口。
   * **必须由 hook 来做**：service 只更新自己的缓存，而界面读的是这里的 state——
   * 只调 service 的话点了没反应（这个坑在联调里踩过一次）。
   */
  loadAround(seq: number): Promise<void>;
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
  // 待发项按会话存：发送失败的项在切走再切回来时还应该在（否则用户以为消息丢了）。
  const [outbox, setOutbox] = useState<ImOutboxItem[]>([]);
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
        // 自己发的那条回来了：把对应乐观项认领掉（按 clientMsgId，不看正文）。
        setOutbox((current) => reconcileOutbox(current, realtime.message));
        return;
      }
      if (realtime.kind === "catch_up") {
        // 补洞拉回的历史消息：静默插入，不触发任何提醒。
        setMessages((current) => mergeMessages(current, realtime.messages));
        // 断线期间发出去的消息也可能从补洞里回来，一并认领。
        setOutbox((current) =>
          realtime.messages.reduce((items, message) => reconcileOutbox(items, message), current),
        );
        return;
      }
      if (realtime.kind === "message_updated") {
        // 编辑/置顶都走这条：整条替换，时间线顺序不变（seq 没变）。
        setMessages((current) =>
          current.map((message) =>
            message.id === realtime.message.id ? realtime.message : message,
          ),
        );
        return;
      }
      if (realtime.kind === "message_reactions") {
        // 回应是"对已有消息的局部更新"：直接替换那一条，不动时间线顺序。
        // 自己的点击也走这条（服务端不过滤发起端），所以本地操作和别人的操作是同一条更新路径。
        setMessages((current) =>
          current.map((message) =>
            message.id === realtime.messageId
              ? { ...message, reactions: realtime.reactions }
              : message,
          ),
        );
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

  /**
   * 发送：先在本地落一条乐观项（立刻可见），再按 clientMsgId 发出去。
   * 失败不删、不改正文——留着给用户重试或放弃，比"消息凭空消失"诚实。
   */
  const deliver = useCallback(
    async (
      clientMsgId: string,
      body: string,
      replyToId?: string,
      kind?: "attachment",
      mentionIds?: string[],
    ): Promise<boolean> => {
      if (!service || !conversationId) return false;
      setSending(true);
      setOutbox((current) => markOutboxSending(current, clientMsgId));
      try {
        const message = await service.sendMessage({
          conversationId,
          body,
          clientMsgId,
          ...(replyToId ? { replyToId } : {}),
          ...(kind ? { kind } : {}),
          ...(mentionIds && mentionIds.length > 0 ? { mentionIds } : {}),
        });
        setMessages((current) => mergeMessages(current, [message]));
        setOutbox((current) => reconcileOutbox(current, message));
        return true;
      } catch (error) {
        logger.warn("[im] 发送消息失败", error);
        setOutbox((current) => markOutboxFailed(current, clientMsgId));
        return false;
      } finally {
        setSending(false);
      }
    },
    [service, conversationId],
  );

  const send = useCallback(
    async (
      body: string,
      replyTo?: ImOutboxReply | null,
      mentionIds?: string[],
    ): Promise<boolean> => {
      if (!service || !conversationId) return false;
      const trimmed = body.trim();
      if (!trimmed) return false;
      const clientMsgId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      setOutbox((current) => [
        ...current,
        createOutboxItem({
          clientMsgId,
          conversationId,
          body: trimmed,
          now: Date.now(),
          replyTo: replyTo ?? null,
        }),
      ]);
      return deliver(clientMsgId, trimmed, replyTo?.messageId, undefined, mentionIds);
    },
    [service, conversationId, deliver],
  );

  /** 附件那条的 body 是结构化载荷，走同一条乐观发送路径（上传在调用方完成）。 */
  const sendAttachment = useCallback(
    async (body: string): Promise<boolean> => {
      if (!service || !conversationId) return false;
      const clientMsgId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      setOutbox((current) => [
        ...current,
        createOutboxItem({ clientMsgId, conversationId, body, now: Date.now() }),
      ]);
      return deliver(clientMsgId, body, undefined, "attachment");
    },
    [service, conversationId, deliver],
  );

  const retry = useCallback(
    async (clientMsgId: string): Promise<boolean> => {
      const item = outbox.find((candidate) => candidate.clientMsgId === clientMsgId);
      if (!item) return false;
      // 重试必须带上原来的引用，否则重发出去的那条会丢掉引用关系。
      return deliver(clientMsgId, item.body, item.replyTo?.messageId);
    },
    [outbox, deliver],
  );

  const discard = useCallback((clientMsgId: string): void => {
    setOutbox((current) => current.filter((item) => item.clientMsgId !== clientMsgId));
  }, []);

  const loadAround = useCallback(
    async (seq: number): Promise<void> => {
      if (!service || !conversationId) return;
      try {
        const result = await service.loadAround({ conversationId, seq, limit: 60 });
        setMessages((current) => mergeMessages(current, result.messages));
        setLoaded(true);
      } catch (error) {
        logger.warn("[im] 加载上下文失败", error);
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

  return {
    messages,
    outbox: outboxForConversation(outbox, conversationId ?? ""),
    loaded,
    sending,
    loadingOlder,
    hasMore,
    send,
    sendAttachment,
    retry,
    discard,
    loadOlder,
    loadAround,
  };
}
