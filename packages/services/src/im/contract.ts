import type { Event } from "@zcode/rpc";
import {
  ServiceChannels,
  type ImConversation,
  type ImConversationSummary,
  type ImDirectoryUser,
  type ImEntitlement,
  type ImAttachment,
  type ImBookmarkItem,
  type ImGlobalSearchPage,
  type ImMember,
  type ImMessage,
  type ImReaction,
  type ImWorkReport,
  type ImSearchPage,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type {
  ImAttachment,
  ImBookmarkItem,
  ImConversation,
  ImConversationKind,
  ImConversationSummary,
  ImDirectoryUser,
  ImEntitlement,
  ImMember,
  ImMessage,
  ImWorkReport,
  ImGlobalSearchPage,
  ImMessageKind,
  ImReaction,
  ImReplyPreview,
  ImSearchPage,
  ImSystemAction,
} from "@zcode/shared";

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

/**
 * 基础 IM 服务。所有写操作都在服务端二次校验（白名单 + 成员），
 * 这里做的是状态编排：会话列表、未读、实时投递与断线补洞。
 */
export interface IImService {
  getView(): Promise<ImView>;
  /** 重新拉准入结果与会话列表（登录后、进入 IM 面板、手动刷新时调用）。 */
  refresh(): Promise<ImView>;
  searchDirectory(query: string): Promise<ImDirectoryUser[]>;
  /** 打开会话：拉最新一页消息并上报已读，返回本地缓存的那一页。 */
  openConversation(conversationId: string): Promise<ImMessagesView>;
  /** 向上翻历史。 */
  loadOlder(conversationId: string, before: number, limit?: number): Promise<ImMessagesView>;
  /**
   * 发消息。`clientMsgId` 由调用方给定时会原样使用（重试同一条就传同一个 id，服务端按 id 去重）；
   * 不传则内部生成。
   */
  sendMessage(input: {
    conversationId: string;
    body: string;
    clientMsgId?: string;
  }): Promise<ImMessage>;
  markRead(input: { conversationId: string; seq: number }): Promise<void>;
  createDm(memberId: string): Promise<ImConversation>;
  createGroup(input: { title: string; memberIds: string[] }): Promise<ImConversation>;
  withdrawMessage(input: { conversationId: string; messageId: string }): Promise<void>;
  renameConversation(input: { conversationId: string; title: string }): Promise<ImConversation>;
  addMembers(input: { conversationId: string; memberIds: string[] }): Promise<void>;
  removeMember(input: { conversationId: string; memberId: string }): Promise<void>;
  /** 群设置显示成员：返回成员 id（姓名由 UI 用通讯录解析）。 */
  listMembers(conversationId: string): Promise<string[]>;
  /** 编辑消息（只有发送者）。 */
  editMessage(input: {
    conversationId: string;
    messageId: string;
    body: string;
  }): Promise<ImMessage>;
  /** 置顶/取消置顶（会话成员都能操作，服务端广播）。 */
  setMessagePinned(input: {
    conversationId: string;
    messageId: string;
    pinned: boolean;
  }): Promise<ImMessage>;
  /** 会话内已置顶的消息。 */
  listPinnedMessages(conversationId: string): Promise<ImMessage[]>;
  /** 提交工作汇报：服务端落库并给收件人投一张卡片（正文与附件都在服务端）。 */
  submitReport(input: {
    periodKey: string;
    title: string;
    summary?: string;
    content?: string;
    problems?: string;
    type?: string;
    tags?: string[];
    attachmentIds?: string[];
    recipientIds: string[];
  }): Promise<{ report: ImWorkReport; message: ImMessage }>;
  /**
   * 卡片上的服务端动作（「已阅 / 退回」）。**授权由服务端判**：非审核人拿到 403 原文，
   * 客户端只负责显示，不做按钮级预判（specs/messaging-and-channels.md §12.18）。
   */
  reviewWorkItem(input: {
    itemId: string;
    status: "reviewed" | "returned";
    comment?: string;
  }): Promise<{ itemId: string; status: string }>;
  /** 我发的 + 我收到的汇报（云端记录，可按周期过滤）。 */
  listReports(input?: {
    periodKey?: string;
    authorId?: string;
    limit?: number;
  }): Promise<ImWorkReport[]>;
  getReport(reportId: string): Promise<ImWorkReport>;

  /** 收藏/取消收藏（每人一份，不广播）。 */
  setBookmark(input: { messageId: string; bookmarked: boolean }): Promise<{ bookmarked: boolean }>;
  /** 我的收藏（带所在会话）。 */
  listBookmarks(): Promise<ImBookmarkItem[]>;
  /** 全历史检索：服务端搜整段历史，按 seq 倒序，可继续往前翻。 */
  searchMessages(input: {
    conversationId: string;
    query: string;
    before?: number;
    limit?: number;
  }): Promise<ImSearchPage>;
  /** **全局检索**：我所在的所有会话（结果带会话信息）。 */
  searchAllMessages(input: {
    query: string;
    before?: number;
    limit?: number;
  }): Promise<ImGlobalSearchPage>;
  /** 取某条消息前后的上下文窗口（检索命中要跳过去，那条通常不在已加载的那一页里）。 */
  loadAround(input: {
    conversationId: string;
    seq: number;
    limit: number;
  }): Promise<ImMessagesView>;
  /** 成员面板：角色 + 在线（在线状态由服务端连接中心给出）。 */
  listMemberDetails(conversationId: string): Promise<ImMember[]>;
  /** 表情回应：加/取消，返回该条消息聚合后的结果。 */
  addReaction(input: {
    conversationId: string;
    messageId: string;
    emoji: string;
  }): Promise<ImReaction[]>;
  removeReaction(input: {
    conversationId: string;
    messageId: string;
    emoji: string;
  }): Promise<ImReaction[]>;
  /** 附件：上传（元数据 + 字节）与按需下载。 */
  uploadAttachment(input: {
    conversationId: string;
    name: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<ImAttachment>;
  downloadAttachment(attachmentId: string): Promise<Uint8Array>;
  /** 正在输入：节流由调用方做，这里只负责发（失败静默——它不是关键路径）。 */
  sendTyping(conversationId: string): void;
  onDidChange: Event<ImView>;
  onRealtime: Event<ImRealtimeEvent>;
}
export const IImService = createServiceDescriptor<IImService>(ServiceChannels.Im);
