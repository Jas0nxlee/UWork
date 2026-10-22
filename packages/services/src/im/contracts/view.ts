import type { ImConversationSummary, ImEntitlement, ImMessage, ImReaction } from "@zcode/shared";

/** WS 连接状态。`forbidden` 是终态（不在白名单），`unavailable` 会退避重试。 */
export type ImConnectionStatus =
  | "idle"
  | "connecting"
  | "online"
  | "retrying"
  | "unavailable"
  | "forbidden";

export interface ImView {
  /**
   * 准入结果。`null` 表示还查不到（网络失败等）——**不要当成"没权限"**，
   * 否则一次网络抖动会把入口永久藏起来。只有明确的 `enabled === false` 才隐藏。
   */
  entitlement: ImEntitlement | null;
  conversations: ImConversationSummary[];
  connection: ImConnectionStatus;
  lastError: string | null;
  /** 当前登录用户 id（由 WS 的 `ready` 帧带回）；未连接时为 null，UI 据此对齐消息气泡。 */
  selfUserId: string | null;
}

export interface ImMessagesView {
  conversationId: string;
  messages: ImMessage[];
  /** 补洞之后仍然可能为 true（表示还有更早的历史，UI 可以继续往上翻）。 */
  hasMore: boolean;
}

export type ImRealtimeEvent =
  | { kind: "message"; conversationId: string; message: ImMessage }
  | { kind: "read"; conversationId: string; userId: string; seq: number }
  | { kind: "message_deleted"; conversationId: string; messageId: string }
  /** 消息被改（编辑正文 / 置顶）：整条替换。 */
  | { kind: "message_updated"; conversationId: string; message: ImMessage }
  /** 在线状态变化：只带"谁变了"，全量名单由成员面板按需拉。 */
  | { kind: "presence"; conversationId: string; userId: string; online: boolean }
  /** 表情回应变化：整条消息的回声被替换（带 count 与 userIds）。 */
  | {
      kind: "message_reactions";
      conversationId: string;
      messageId: string;
      reactions: ImReaction[];
    }
  /** 正在输入（瞬时，不落库）。 */
  | { kind: "typing"; conversationId: string; userId: string }
  /**
   * 重连补洞拉回来的历史消息。刻意与 `message` 分开：补洞不是"刚发生的事"，
   * UI 要静默插入而不是弹通知（否则一次断线重连会刷一屏提醒）。
   */
  | { kind: "catch_up"; conversationId: string; messages: ImMessage[] };
