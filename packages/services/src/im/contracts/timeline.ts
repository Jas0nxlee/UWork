import type { ImMessage } from "@zcode/shared";
import type { ImMessagesView } from "./view.js";

/** 既有 RPC 服务的能力分组；方法名与参数保持兼容。 */
export interface ImTimelineCommands {
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
  withdrawMessage(input: { conversationId: string; messageId: string }): Promise<void>;
  /** 编辑消息（只有发送者）。 */
  editMessage(input: {
    conversationId: string;
    messageId: string;
    body: string;
  }): Promise<ImMessage>;
  /** 取某条消息前后的上下文窗口（检索命中要跳过去，那条通常不在已加载的那一页里）。 */
  loadAround(input: {
    conversationId: string;
    seq: number;
    limit: number;
  }): Promise<ImMessagesView>;
}
