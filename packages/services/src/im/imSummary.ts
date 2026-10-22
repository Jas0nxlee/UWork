import type { ImConversationSummary, ImMessage } from "@zcode/shared";

/**
 * 会话摘要的本地推进（未读、提及、"最近一条"）。
 *
 * 这些规则必须和实时帧**同步**发生：等下一次 refresh 才点亮"有人@我"，用户就会先看到
 * 消息进来、再看到角标跳一下——那种错位感比不显示更糟。
 *
 * 抽成纯函数是为了能直接测：这里的判定条件很细（自己的消息不算未读、正在看的会话不算未读、
 * 只有到点的新消息才算、@全体 等同于 @我），散在服务里只能靠模拟一整条链路才能测到。
 */
export interface ImSummaryContext {
  selfUserId: string | null;
  /** 用户此刻正在看的会话：在看的会话不累计未读（收到即已读）。 */
  activeConversationId: string | null;
}

/** 这条消息是否在叫我：直接 @我，或 @全体。 */
export function isMentioned(message: ImMessage, selfUserId: string | null): boolean {
  if (selfUserId === null) return false;
  return message.mentions.includes(selfUserId) || message.mentions.includes("all");
}

export interface ImSummaryAdvance {
  conversations: ImConversationSummary[];
  /** 正在看的会话收到别人的消息：调用方据此上报已读（失败不回滚未读，下次打开会对齐）。 */
  markReadSeq: number | null;
  /** 这条消息是否让未读 +1（用于测试与判断要不要提示）。 */
  countedAsUnread: boolean;
}

/**
 * 把一条新消息折进会话列表。
 *
 * 只有"别人的、我没在看的、且比本地已知的最后一条更新"的消息才算未读；
 * 自己的消息（多端同步回来的）与重复投递的旧 seq 都不算。
 */
export function advanceSummaries(
  current: ImConversationSummary[],
  message: ImMessage,
  context: ImSummaryContext,
): ImSummaryAdvance {
  const index = current.findIndex((conversation) => conversation.id === message.conversationId);
  const existing = index >= 0 ? current[index] : undefined;
  if (!existing) return { conversations: current, markReadSeq: null, countedAsUnread: false };

  const isMine = message.senderId === context.selfUserId;
  const isActive = context.activeConversationId === message.conversationId;
  const counted = !isMine && !isActive && message.seq > existing.lastSeq;
  const mentioned = counted && isMentioned(message, context.selfUserId);
  const next: ImConversationSummary = {
    ...existing,
    lastSeq: Math.max(existing.lastSeq, message.seq),
    lastMessage: message,
    updatedAt: message.createdAt,
    unreadCount: counted ? existing.unreadCount + 1 : existing.unreadCount,
    mentionCount: mentioned ? (existing.mentionCount ?? 0) + 1 : (existing.mentionCount ?? 0),
  };
  const conversations = [...current.slice(0, index), next, ...current.slice(index + 1)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  return {
    conversations,
    markReadSeq: isActive && !isMine ? message.seq : null,
    countedAsUnread: counted,
  };
}

/**
 * 同一用户的**另一台设备**上报了已读：未读与提及都清零。
 *
 * 为什么由收到 `read` 帧的这一端来处理：我们的未读是"每用户一个计数器"（`last_read_seq`），
 * 不是每设备一份——手机上读了，桌面就不该继续挂红点（微信/企微也是这个语义）。
 * 服务端只广播"谁把这个会话读到哪了"，落到本地就是"那是你自己 → 清掉未读"。
 */
export function applyReadReceipt(
  current: ImConversationSummary[],
  conversationId: string,
  seq: number,
): ImConversationSummary[] {
  return current.map((conversation) =>
    conversation.id === conversationId
      ? {
          ...conversation,
          lastReadSeq: Math.max(conversation.lastReadSeq, seq),
          unreadCount: 0,
          mentionCount: 0,
        }
      : conversation,
  );
}
