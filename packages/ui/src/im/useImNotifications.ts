import { useEffect, useRef } from "react";
import type { IImService, ImRealtimeEvent } from "@zcode/services";
import type { ImConversationSummary, ImMessage } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  getActiveImConversation,
  getImConversationTitle,
  requestOpenImConversation,
} from "./imNotificationRouter.js";

/**
 * 系统通知 + 应用角标。
 *
 * 三条判断：
 * 1. **只对"不在看"的消息弹**：正在看的那个会话不弹（否则每来一条都在自己脸上弹一次）；
 *    窗口没聚焦时其它会话照弹——用户人在别的应用里，这正是通知的用途。
 * 2. **自己发的不弹**（多端时另一端发的也只是自己的话）。
 * 3. 角标用**未读总数（排除静音）**，点通知先聚焦窗口再切会话——
 *    不聚焦的话通知点了没反应，用户会以为坏了。
 */
export function useImNotifications(service: IImService | null): void {
  const selfUserIdRef = useRef<string | null>(null);
  /** 会话标题（通知上要写清来自哪个会话）与自己的 id：都从视图里来，订阅着更新。 */
  const titlesRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!service) return;
    const apply = (view: unknown): void => {
      const conversations =
        (view as { conversations?: ImConversationSummary[] })?.conversations ?? [];
      titlesRef.current = new Map(conversations.map((item) => [item.id, item.title ?? "单聊"]));
    };
    const subscription = service.onDidChange(apply);
    void service
      .getView()
      .then(apply)
      .catch(() => undefined);
    return () => subscription.dispose();
  }, [service]);

  useEffect(() => {
    if (!service) return;
    const subscription = service.onRealtime((event) => {
      const realtime = event as ImRealtimeEvent;
      if (realtime.kind !== "message") return;
      const message: ImMessage = realtime.message;
      const selfUserId = selfUserIdRef.current;
      if (selfUserId && message.senderId === selfUserId) return;
      if (message.kind === "system") return;
      // 正在这个会话里（且窗口聚焦）就不打扰
      if (
        getActiveImConversation() === realtime.conversationId &&
        typeof document !== "undefined"
      ) {
        if (document.visibilityState === "visible") return;
      }
      showNotification(
        getImConversationTitle(realtime.conversationId) ??
          titlesRef.current.get(realtime.conversationId) ??
          "新消息",
        realtime.conversationId,
        message,
      );
    });
    return () => subscription.dispose();
  }, [service, titlesRef, selfUserIdRef]);
}

function showNotification(title: string, conversationId: string, message: ImMessage): void {
  if (typeof Notification === "undefined") return;
  try {
    if (Notification.permission !== "granted") return;
    const notification = new Notification(title, {
      body: message.kind === "attachment" ? "[附件]" : message.body.slice(0, 120),
      silent: false,
    });
    notification.onclick = () => {
      // 先聚焦窗口：不聚焦的话点了通知只闪一下，用户会以为没生效
      window.focus();
      requestOpenImConversation(conversationId);
      notification.close();
    };
  } catch (error) {
    logger.warn("[im] 弹出通知失败", error);
  }
}
