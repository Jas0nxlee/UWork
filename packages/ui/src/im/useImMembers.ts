import { useEffect, useState } from "react";
import type { IImService } from "@zcode/services";
import type { ImMember } from "@zcode/shared";
import { logger } from "@/logger.js";

/**
 * 当前会话的成员详情（含在线状态）。
 *
 * 抽成 hook 的理由：这里有两个**必须一起改**的订阅——整份重拉（`presence` 只带"谁变了"，
 * 所以进会话与连接恢复各拉一次）与就地打补丁（同一份帧只改那一个人）。分在两处写，
 * 迟早出现"有人上线了但面板还显示离线"。
 */
export function useImMembers(
  service: IImService | null,
  conversationId: string | null,
): ImMember[] {
  const [members, setMembers] = useState<ImMember[]>([]);

  useEffect(() => {
    setMembers([]);
    if (!service || !conversationId) return;
    let active = true;
    const load = (): void => {
      void service
        .listMemberDetails(conversationId)
        .then((details) => {
          if (active) setMembers(details);
        })
        .catch((error: unknown) => {
          logger.warn("[im] 读取成员失败", error);
        });
    };
    load();
    // 在线状态只来自服务端：连接恢复后重新拉一次，避免面板停在"全部离线"。
    const subscription = service.onRealtime((event) => {
      const realtime = event as { kind?: string; conversationId?: string };
      if (realtime.kind === "presence" && realtime.conversationId === conversationId) load();
    });
    return () => {
      active = false;
      subscription.dispose();
    };
  }, [service, conversationId]);

  // 在线状态变化也要反映到成员详情里（不重拉全量：presence 帧只带"谁变了"）。
  useEffect(() => {
    if (!service) return;
    const subscription = service.onRealtime((event) => {
      const realtime = event as {
        kind?: string;
        conversationId?: string;
        userId?: string;
        online?: boolean;
      };
      if (realtime.kind !== "presence" || realtime.conversationId !== conversationId) return;
      setMembers((current) =>
        current.map((member) =>
          member.id === realtime.userId ? { ...member, online: realtime.online === true } : member,
        ),
      );
    });
    return () => subscription.dispose();
  }, [service, conversationId]);

  return members;
}
