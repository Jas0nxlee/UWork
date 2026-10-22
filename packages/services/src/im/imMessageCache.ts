import type { ImMessage, ImReaction } from "@zcode/shared";

/**
 * 会话内的消息缓存。
 *
 * 抽出来的理由不是行数，而是**"改一条已存在的消息"有五种来源**：广播帧（编辑/撤回/表情）、
 * 自己编辑、自己置顶、自己撤回、自己点表情。以前每处都自己 findIndex + 赋值，
 * 五份实现里漏一份就是"点完没反应"或"别人的编辑到了我这没生效"。
 * 这里把"怎么改缓存"收成一份，调用方只说意图（替换 / 打补丁 / 追加窗口）。
 */
export interface ImMessageCache {
  list(conversationId: string): ImMessage[];
  /** 整段替换（打开会话、补洞）。 */
  set(conversationId: string, messages: ImMessage[]): void;
  upsert(message: ImMessage): void;
  upsertMany(messages: Iterable<ImMessage>): void;
  /** 往上翻页：旧消息插到前面，仍按 seq 排序。 */
  prependOlder(conversationId: string, older: ImMessage[]): void;
  /** 跳转用的上下文窗口：与缓存里的消息按 seq 去重合并。 */
  mergeWindow(conversationId: string, messages: ImMessage[]): void;
  /** 按 id 整条替换（编辑、置顶：seq 不变，只是内容/标记变了）。 */
  replace(message: ImMessage): void;
  /** 按 id 打补丁（撤回、表情：只有局部字段变）。 */
  patch(conversationId: string, messageId: string, patch: (message: ImMessage) => ImMessage): void;
  /** 本地已有的最大 seq（补洞的起点）。 */
  newestSeq(conversationId: string): number;
}

export function createImMessageCache(): ImMessageCache {
  const byConversation = new Map<string, ImMessage[]>();

  function sort(list: ImMessage[]): ImMessage[] {
    return [...list].sort((a, b) => a.seq - b.seq);
  }

  return {
    list(conversationId) {
      return byConversation.get(conversationId) ?? [];
    },
    set(conversationId, messages) {
      byConversation.set(conversationId, sort(messages));
    },
    upsert(message) {
      const list = byConversation.get(message.conversationId) ?? [];
      const index = list.findIndex((item) => item.id === message.id || item.seq === message.seq);
      if (index >= 0) list[index] = message;
      else list.push(message);
      byConversation.set(message.conversationId, sort(list));
    },
    upsertMany(messages) {
      for (const message of messages) this.upsert(message);
    },
    prependOlder(conversationId, older) {
      byConversation.set(
        conversationId,
        sort([...older, ...(byConversation.get(conversationId) ?? [])]),
      );
    },
    mergeWindow(conversationId, messages) {
      const bySeq = new Map<number, ImMessage>();
      for (const message of [...(byConversation.get(conversationId) ?? []), ...messages]) {
        bySeq.set(message.seq, message);
      }
      byConversation.set(conversationId, sort([...bySeq.values()]));
    },
    replace(message) {
      this.patch(message.conversationId, message.id, () => message);
    },
    patch(conversationId, messageId, apply) {
      const list = byConversation.get(conversationId);
      if (!list) return;
      const index = list.findIndex((item) => item.id === messageId);
      const existing = index >= 0 ? list[index] : undefined;
      if (existing) list[index] = apply(existing);
    },
    newestSeq(conversationId) {
      return byConversation.get(conversationId)?.at(-1)?.seq ?? 0;
    },
  };
}

/** 撤回：正文与附件都必须抹掉，只留一行"已撤回"的占位。 */
export function withdrawPatch(message: ImMessage, now: number): ImMessage {
  return { ...message, body: "", deletedAt: now };
}

/** 表情：整组替换（服务端返回的是聚合后的结果，不是增量）。 */
export function reactionsPatch(reactions: ImReaction[]): (message: ImMessage) => ImMessage {
  return (message) => ({ ...message, reactions });
}
