import { useCallback, useEffect, useRef, useState } from "react";
import type { IImService, ImRealtimeEvent } from "@zcode/services";

/** 输入中提示的滞留时间：服务端只转发"正在输入"，停下来的撤销由这里做（超时即消失）。 */
const TYPING_TTL_MS = 4000;
/** 我自己最多每 3 秒发一次 typing——每敲一个字发一次是拿帧换噪声。 */
const TYPING_THROTTLE_MS = 3000;

/**
 * "正在输入"。
 *
 * 两个判断：
 * 1. **节流 + 超时**：发送侧节流（不然每次按键都发一帧），接收侧超时（对方停手后提示要自己消失——
 *    服务端不负责撤销，瞬时事件写库/发撤销帧都不值当）。
 * 2. **排除自己**：服务端已经不会把帧发回发起端，但多端登录时"我自己的另一台设备"也在输入，
 *    那种情况显示"你正在输入"没有意义，所以在客户端也过滤掉自己的 id。
 */
export function useImTyping(
  service: IImService | null,
  conversationId: string | null,
  selfUserId: string | null,
): { typingUserIds: string[]; notifyTyping: () => void } {
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const lastSentAtRef = useRef(0);
  const timersRef = useRef(new Map<string, number>());

  useEffect(() => {
    // 换会话就把状态清干净：上一个会话的"正在输入"不该跟过来。
    setTypingUserIds([]);
    for (const timer of timersRef.current.values()) window.clearTimeout(timer);
    timersRef.current.clear();
    if (!service || !conversationId) return;
    const subscription = service.onRealtime((event) => {
      const realtime = event as ImRealtimeEvent;
      if (realtime.kind !== "typing" || realtime.conversationId !== conversationId) return;
      if (realtime.userId === selfUserId) return;
      setTypingUserIds((current) =>
        current.includes(realtime.userId) ? current : [...current, realtime.userId],
      );
      const existing = timersRef.current.get(realtime.userId);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        timersRef.current.delete(realtime.userId);
        setTypingUserIds((current) => current.filter((id) => id !== realtime.userId));
      }, TYPING_TTL_MS);
      timersRef.current.set(realtime.userId, timer);
    });
    return () => {
      subscription.dispose();
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
    };
  }, [service, conversationId, selfUserId]);

  const notifyTyping = useCallback(() => {
    if (!service || !conversationId) return;
    const now = Date.now();
    if (now - lastSentAtRef.current < TYPING_THROTTLE_MS) return;
    lastSentAtRef.current = now;
    service.sendTyping(conversationId);
  }, [service, conversationId]);

  return { typingUserIds, notifyTyping };
}
