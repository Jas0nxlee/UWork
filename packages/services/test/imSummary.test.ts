import { describe, expect, it } from "vitest";
import type { ImConversationSummary, ImMessage } from "@zcode/shared";
import { advanceSummaries, applyReadReceipt, isMentioned } from "../src/im/imSummary.js";

const NOW = new Date("2026-10-18T10:00:00+08:00").getTime();

const message = (over: Partial<ImMessage> = {}): ImMessage => ({
  id: "m1",
  conversationId: "c1",
  seq: 10,
  senderId: "u-lv",
  kind: "text",
  body: "在吗",
  clientMsgId: null,
  createdAt: NOW,
  editedAt: null,
  deletedAt: null,
  replyTo: null,
  reactions: [],
  mentions: [],
  pinnedAt: null,
  ...over,
});

const summary = (over: Partial<ImConversationSummary> = {}): ImConversationSummary => ({
  id: "c1",
  orgId: "org",
  kind: "group",
  title: "项目组",
  createdBy: "u-me",
  dmKey: null,
  lastSeq: 9,
  lastReadSeq: 9,
  unreadCount: 0,
  mentionCount: 0,
  updatedAt: NOW - 1000,
  lastMessage: null,
  ...over,
});

const context = { selfUserId: "u-me", activeConversationId: null };

describe("提及判定", () => {
  it("@我 与 @全体 都算叫我", () => {
    expect(isMentioned(message({ mentions: ["u-me"] }), "u-me")).toBe(true);
    expect(isMentioned(message({ mentions: ["all"] }), "u-me")).toBe(true);
    expect(isMentioned(message({ mentions: ["u-other"] }), "u-me")).toBe(false);
    expect(isMentioned(message(), "u-me")).toBe(false);
  });

  it("还不知道自己是谁时（selfUserId 为空）不算提及", () => {
    expect(isMentioned(message({ mentions: ["all"] }), null)).toBe(false);
  });
});

describe("会话摘要推进", () => {
  it("别人的新消息：未读 +1，顺带记住最近一条", () => {
    const result = advanceSummaries([summary()], message(), context);
    expect(result.countedAsUnread).toBe(true);
    expect(result.conversations[0]?.unreadCount).toBe(1);
    expect(result.conversations[0]?.lastSeq).toBe(10);
    expect(result.conversations[0]?.lastMessage?.id).toBe("m1");
  });

  it("被 @ 的消息同时把「提到我」计上（列表要能单独标出来）", () => {
    const result = advanceSummaries([summary()], message({ mentions: ["u-me"] }), context);
    expect(result.conversations[0]?.unreadCount).toBe(1);
    expect(result.conversations[0]?.mentionCount).toBe(1);
  });

  it("没 @我的消息不涨提及数（只有未读）", () => {
    const result = advanceSummaries([summary()], message({ mentions: ["u-other"] }), context);
    expect(result.conversations[0]?.mentionCount).toBe(0);
  });

  it("自己发的消息（多端同步回来）不算未读、也不算提及", () => {
    const result = advanceSummaries(
      [summary()],
      message({ senderId: "u-me", mentions: ["all"] }),
      context,
    );
    expect(result.countedAsUnread).toBe(false);
    expect(result.conversations[0]?.unreadCount).toBe(0);
    expect(result.conversations[0]?.mentionCount).toBe(0);
  });

  it("正在看的会话不累计未读，但要回报已读位置", () => {
    const result = advanceSummaries([summary()], message(), {
      selfUserId: "u-me",
      activeConversationId: "c1",
    });
    expect(result.countedAsUnread).toBe(false);
    expect(result.conversations[0]?.unreadCount).toBe(0);
    expect(result.markReadSeq).toBe(10);
  });

  it("重复投递的旧消息（seq 不比已知的新）不重复计数", () => {
    const result = advanceSummaries([summary({ lastSeq: 20 })], message({ seq: 12 }), context);
    expect(result.countedAsUnread).toBe(false);
    expect(result.conversations[0]?.unreadCount).toBe(0);
  });

  it("会话列表里没有这个会话时原样返回（由调用方决定要不要刷新）", () => {
    const current = [summary({ id: "c-other" })];
    const result = advanceSummaries(current, message({ conversationId: "c-new" }), context);
    expect(result.conversations).toBe(current);
    expect(result.markReadSeq).toBeNull();
  });

  it("有新消息的会话排到列表最前", () => {
    const older = summary({ id: "c1", updatedAt: NOW - 10_000 });
    const newer = summary({ id: "c2", updatedAt: NOW - 5_000, lastSeq: 3 });
    const result = advanceSummaries([newer, older], message({ conversationId: "c1" }), context);
    expect(result.conversations.map((item) => item.id)).toEqual(["c1", "c2"]);
  });
});

describe("同一用户另一台设备的已读回执", () => {
  it("别的端读完：本地未读与提及都清零，已读位置推进", () => {
    const current = [
      summary({ unreadCount: 3, mentionCount: 1, lastReadSeq: 5 }),
      summary({ id: "c2", unreadCount: 2, mentionCount: 0, lastReadSeq: 1 }),
    ];
    const next = applyReadReceipt(current, "c1", 9);
    expect(next[0]).toMatchObject({ unreadCount: 0, mentionCount: 0, lastReadSeq: 9 });
    // 别的会话不受影响
    expect(next[1]).toMatchObject({ unreadCount: 2, mentionCount: 0, lastReadSeq: 1 });
  });

  it("已读位置只前进不回退（乱序到达的旧回执不会把未读又拉回来）", () => {
    const next = applyReadReceipt([summary({ lastReadSeq: 7 })], "c1", 3);
    expect(next[0]?.lastReadSeq).toBe(7);
  });

  it("不认识的会话原样返回", () => {
    const current = [summary()];
    expect(applyReadReceipt(current, "c-unknown", 3)).toEqual(current);
  });
});
