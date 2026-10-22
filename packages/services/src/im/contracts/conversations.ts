import type { ImConversation, ImDirectoryUser, ImMember } from "@zcode/shared";
import type { ImView } from "./view.js";

/** 既有 RPC 服务的能力分组；方法名与参数保持兼容。 */
export interface ImConversationCommands {
  getView(): Promise<ImView>;
  /** 重新拉准入结果与会话列表（登录后、进入 IM 面板、手动刷新时调用）。 */
  refresh(): Promise<ImView>;
  searchDirectory(query: string): Promise<ImDirectoryUser[]>;
  createDm(memberId: string): Promise<ImConversation>;
  createGroup(input: { title: string; memberIds: string[] }): Promise<ImConversation>;
  renameConversation(input: { conversationId: string; title: string }): Promise<ImConversation>;
  addMembers(input: { conversationId: string; memberIds: string[] }): Promise<void>;
  removeMember(input: { conversationId: string; memberId: string }): Promise<void>;
  /** 群设置显示成员：返回成员 id（姓名由 UI 用通讯录解析）。 */
  listMembers(conversationId: string): Promise<string[]>;
  /** 成员面板：角色 + 在线（在线状态由服务端连接中心给出）。 */
  listMemberDetails(conversationId: string): Promise<ImMember[]>;
}
