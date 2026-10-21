/**
 * 出站队列（本地乐观消息）。
 *
 * 为什么需要它：发送是"点一下然后等"的动作，成熟 IM 都会立刻把消息画上去，
 * 状态由发送结果决定——等回包才画，在弱网下就是"点了没反应"。
 *
 * 两条不能省的规则：
 * 1. **一条待发消息只对应一个 `clientMsgId`**：重试必须复用同一个 id。否则
 *    "请求到了服务端、只是回包丢了"这种最常见的情况会变成两条一样的消息（服务端按 id 去重）。
 * 2. **服务端回包即认领**：`reconcileOutbox` 用 `clientMsgId` 把本地乐观项换掉，
 *    而不看正文——正文可能被服务端规整（去空白等），拿正文匹配会漏。
 */
export type ImOutboxStatus = "sending" | "failed";

/** 待发消息引用的那条的摘要（重试时要原样带上，否则重发出去就丢了引用）。 */
export interface ImOutboxReply {
  messageId: string;
  senderId: string;
  body: string;
}

export interface ImOutboxItem {
  clientMsgId: string;
  conversationId: string;
  body: string;
  createdAt: number;
  status: ImOutboxStatus;
  replyTo: ImOutboxReply | null;
}

export function createOutboxItem(input: {
  clientMsgId: string;
  conversationId: string;
  body: string;
  now: number;
  replyTo?: ImOutboxReply | null;
}): ImOutboxItem {
  return {
    clientMsgId: input.clientMsgId,
    conversationId: input.conversationId,
    body: input.body,
    createdAt: input.now,
    status: "sending",
    replyTo: input.replyTo ?? null,
  };
}

/** 把同一会话的待发项排到时间线上（按创建时间，与真实消息同一把尺子）。 */
export function outboxForConversation(
  items: readonly ImOutboxItem[],
  conversationId: string,
): ImOutboxItem[] {
  return items
    .filter((item) => item.conversationId === conversationId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 发送成功/服务端回包：按 clientMsgId 认领并移除对应乐观项。 */
export function reconcileOutbox(
  items: readonly ImOutboxItem[],
  claimed: { clientMsgId: string | null },
): ImOutboxItem[] {
  if (!claimed.clientMsgId) return [...items];
  return items.filter((item) => item.clientMsgId !== claimed.clientMsgId);
}

export function markOutboxFailed(
  items: readonly ImOutboxItem[],
  clientMsgId: string,
): ImOutboxItem[] {
  return items.map((item) =>
    item.clientMsgId === clientMsgId ? { ...item, status: "failed" as const } : item,
  );
}

export function markOutboxSending(
  items: readonly ImOutboxItem[],
  clientMsgId: string,
): ImOutboxItem[] {
  return items.map((item) =>
    item.clientMsgId === clientMsgId ? { ...item, status: "sending" as const } : item,
  );
}
