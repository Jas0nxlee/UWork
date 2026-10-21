import type {
  ImAttachment,
  ImBookmarkItem,
  ImConversation,
  ImGlobalSearchPage,
  ImMember,
  ImReaction,
  ImSearchPage,
} from "@zcode/shared";
import type { IImService, ImMessagesView, ImView } from "./contract.js";
import type { ImHttpClient } from "./imHttpClient.js";
import { reactionsPatch, withdrawPatch, type ImMessageCache } from "./imMessageCache.js";

/**
 * 对外的**动作**：转发给服务端，并同步本地缓存。
 *
 * 为什么单独成模块：这些方法本身都很薄（一次 HTTP + 一处缓存更新），但数量多，
 * 全塞进服务门面会把"状态机与传输"（handleFrame / catchUp / 发送管线）淹掉。
 * 分界线是——**这里只做"服务端已经同意的事"在本地生效**，不做状态判定。
 */
export interface ImCommandDeps {
  client: ImHttpClient;
  cache: ImMessageCache;
  publish: () => void;
  /** 需要重建整个会话列表的动作（建会话、加/减人）走它。 */
  refresh: () => Promise<ImView>;
  /** 撤回要发一条"本地也走同一条实时事件"的通知，调用方持有 realtime emitter。 */
  emitDeleted: (conversationId: string, messageId: string) => void;
  /** 瞬时事件（typing）：发不出去就算了，不排队也不重试。 */
  sendTyping: (conversationId: string) => void;
  /** 会话成员重命名等"会话属性变了"：把服务端返回的会话折进列表。 */
  applyConversation: (conversation: ImConversation) => void;
  now: () => number;
}

export type ImCommands = Pick<
  IImService,
  | "createDm"
  | "createGroup"
  | "withdrawMessage"
  | "renameConversation"
  | "addMembers"
  | "removeMember"
  | "listMembers"
  | "listMemberDetails"
  | "editMessage"
  | "setMessagePinned"
  | "listPinnedMessages"
  | "setBookmark"
  | "listBookmarks"
  | "searchAllMessages"
  | "searchMessages"
  | "loadAround"
  | "addReaction"
  | "removeReaction"
  | "uploadAttachment"
  | "downloadAttachment"
  | "sendTyping"
  | "submitReport"
  | "listReports"
  | "getReport"
  | "reviewWorkItem"
>;

export function createImCommands(deps: ImCommandDeps): ImCommands {
  const { cache, publish } = deps;

  function applyReactions(
    conversationId: string,
    messageId: string,
    reactions: ImReaction[],
  ): void {
    cache.patch(conversationId, messageId, reactionsPatch(reactions));
    publish();
  }

  return {
    async createDm(memberId: string): Promise<ImConversation> {
      const conversation = await deps.client.createConversation({
        kind: "dm",
        memberIds: [memberId],
      });
      await deps.refresh();
      return conversation;
    },
    async createGroup(input: { memberIds: string[]; title?: string }): Promise<ImConversation> {
      const conversation = await deps.client.createConversation({
        kind: "group",
        memberIds: input.memberIds,
        title: input.title,
      });
      await deps.refresh();
      return conversation;
    },
    async withdrawMessage(input: { conversationId: string; messageId: string }): Promise<void> {
      await deps.client.withdraw(input);
      cache.patch(input.conversationId, input.messageId, (message) =>
        withdrawPatch(message, deps.now()),
      );
      // 本地撤回也发同一条实时事件：UI 只有一条更新路径（另一台设备撤回时也是它），
      // 否则"自己撤回"要靠各组件各自打补丁，迟早漏一处。
      deps.emitDeleted(input.conversationId, input.messageId);
      publish();
    },
    async renameConversation(input: {
      conversationId: string;
      title: string;
    }): Promise<ImConversation> {
      const conversation = await deps.client.rename(input);
      deps.applyConversation(conversation);
      return conversation;
    },
    async addMembers(input: { conversationId: string; memberIds: string[] }): Promise<void> {
      await deps.client.addMembers(input);
      await deps.refresh();
    },
    async removeMember(input: { conversationId: string; memberId: string }): Promise<void> {
      await deps.client.removeMember(input);
      await deps.refresh();
    },
    async listMembers(conversationId: string): Promise<string[]> {
      return deps.client.members(conversationId);
    },
    async listMemberDetails(conversationId: string): Promise<ImMember[]> {
      return deps.client.memberDetails(conversationId);
    },
    /** 编辑：服务端广播给其他人，自己这一端靠这里更新（广播不带排他，两条路都幂等）。 */
    async editMessage(input: { conversationId: string; messageId: string; body: string }) {
      const message = await deps.client.editMessage(input);
      cache.replace(message);
      publish();
      return message;
    },
    async setMessagePinned(input: { conversationId: string; messageId: string; pinned: boolean }) {
      const message = await deps.client.setMessagePinned(input);
      cache.replace(message);
      publish();
      return message;
    },
    async listPinnedMessages(conversationId: string) {
      return deps.client.pinnedMessages(conversationId);
    },
    async setBookmark(input: { messageId: string; bookmarked: boolean }) {
      return deps.client.setBookmark(input);
    },
    async listBookmarks(): Promise<ImBookmarkItem[]> {
      return deps.client.bookmarks();
    },
    async submitReport(input) {
      return deps.client.submitReport(input);
    },
    async listReports(input) {
      const page = await deps.client.reports(input);
      return page.reports;
    },
    async getReport(reportId) {
      return (await deps.client.report(reportId)).report;
    },
    /** 卡片上的服务端动作（已阅/退回）：授权由服务端判，客户端只转达结果。 */
    async reviewWorkItem(input) {
      return deps.client.reviewWorkItem(input);
    },
    /** 与单会话检索一样：结果不进消息缓存（可能是很久以前的窗口），跳转由 loadAround 负责。 */
    async searchAllMessages(input): Promise<ImGlobalSearchPage> {
      return deps.client.searchAll(input);
    },
    async searchMessages(input): Promise<ImSearchPage> {
      return deps.client.searchMessages(input);
    },
    async loadAround(input: {
      conversationId: string;
      seq: number;
      limit: number;
    }): Promise<ImMessagesView> {
      const half = Math.ceil(input.limit / 2);
      const before = await deps.client.messages({
        conversationId: input.conversationId,
        before: input.seq + 1,
        limit: half,
      });
      const after = await deps.client.messages({
        conversationId: input.conversationId,
        since: input.seq - 1,
        limit: Math.floor(input.limit / 2),
      });
      const merged = [...before, ...after];
      // 落到缓存里：跳过去之后继续往上/下翻页要接得上。
      cache.mergeWindow(input.conversationId, merged);
      publish();
      // hasMore 取"往下还有没有"：跳转后继续往上翻由 loadOlder 自己判断。
      return {
        conversationId: input.conversationId,
        messages: merged,
        hasMore: before.length >= half,
      };
    },
    async addReaction(input: { messageId: string; emoji: string; conversationId: string }) {
      const reactions = await deps.client.addReaction(input);
      applyReactions(input.conversationId, input.messageId, reactions);
      return reactions;
    },
    async removeReaction(input: { messageId: string; emoji: string; conversationId: string }) {
      const reactions = await deps.client.removeReaction(input);
      applyReactions(input.conversationId, input.messageId, reactions);
      return reactions;
    },
    async uploadAttachment(input): Promise<ImAttachment> {
      return deps.client.uploadAttachment(input);
    },
    async downloadAttachment(attachmentId: string): Promise<Uint8Array> {
      return deps.client.downloadAttachment(attachmentId);
    },
    sendTyping(conversationId: string): void {
      deps.sendTyping(conversationId);
    },
  };
}
