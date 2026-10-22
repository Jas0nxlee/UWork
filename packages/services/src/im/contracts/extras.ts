import type {
  ImAttachment,
  ImBookmarkItem,
  ImGlobalSearchPage,
  ImMessage,
  ImReaction,
  ImSearchPage,
} from "@zcode/shared";

/** 既有 RPC 服务的能力分组；方法名与参数保持兼容。 */
export interface ImMessageExtras {
  /** 置顶/取消置顶（会话成员都能操作，服务端广播）。 */
  setMessagePinned(input: {
    conversationId: string;
    messageId: string;
    pinned: boolean;
  }): Promise<ImMessage>;
  /** 会话内已置顶的消息。 */
  listPinnedMessages(conversationId: string): Promise<ImMessage[]>;

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
}
