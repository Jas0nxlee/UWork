import { describe, expect, it } from "vitest";
import type { ImConversationSummary, ImMessage } from "@zcode/shared";
import {
  avatarTone,
  buildTimeline,
  conversationPreview,
  conversationTitle,
  formatClockTime,
  formatDayDivider,
  formatListTime,
  initialsOf,
} from "@/im/imPresentation.js";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const NOW = new Date("2026-10-17T15:00:00+08:00").getTime();
const labels = { today: "今天", yesterday: "昨天", weekdays: WEEKDAYS };

const message = (over: Partial<ImMessage> = {}): ImMessage => ({
  id: "m1",
  conversationId: "c1",
  seq: 1,
  senderId: "u-a",
  kind: "text",
  body: "hi",
  clientMsgId: null,
  createdAt: NOW,
  editedAt: null,
  deletedAt: null,
  ...over,
});

describe("头像与缩写", () => {
  it("同一 id 永远同一种色调（颜色不承载语义，但不能闪烁）", () => {
    expect(avatarTone("u-alice")).toBe(avatarTone("u-alice"));
    expect(avatarTone("u-bob")).not.toBe(avatarTone("u-alice"));
  });

  it("中文取后两字，英文取首字母", () => {
    expect(initialsOf("辛晓华")).toBe("晓华");
    expect(initialsOf("王五")).toBe("王五");
    expect(initialsOf("alice zhang")).toBe("AZ");
    expect(initialsOf("bob")).toBe("BO");
    expect(initialsOf("")).toBe("?");
  });
});

describe("时间组织（成熟 IM 的惯例：今天给时刻、昨天给字、本周给周几、更早给日期）", () => {
  it("会话行时间", () => {
    expect(formatListTime(NOW, NOW, labels)).toMatch(/\d/);
    expect(formatListTime(NOW - 86_400_000, NOW, labels)).toBe("昨天");
    expect(formatListTime(NOW - 2 * 86_400_000, NOW, labels)).toBe("周四");
    expect(formatListTime(NOW - 20 * 86_400_000, NOW, labels)).toMatch(/\d/);
  });

  it("消息行时间只给时刻（日期已由分隔线表达）", () => {
    const now = new Date("2026-10-17T15:04:00+08:00").getTime();
    // 时刻按运行环境的语言格式化：中文是 15:04，英文是 3:04 PM。
    expect(formatClockTime(now)).toMatch(/^\d{1,2}:\d{2}(\s?[AP]M)?$/);
  });

  it("日期分隔标签", () => {
    expect(formatDayDivider(NOW, NOW, labels)).toBe("今天");
    expect(formatDayDivider(NOW - 86_400_000, NOW, labels)).toBe("昨天");
    expect(formatDayDivider(NOW - 2 * 86_400_000, NOW, labels)).toBe("周四");
    expect(formatDayDivider(NOW - 20 * 86_400_000, NOW, labels)).toMatch(/2026/);
  });
});

describe("会话行预览", () => {
  const conversation = (over: Partial<ImConversationSummary> = {}): ImConversationSummary => ({
    id: "c1",
    orgId: "org",
    kind: "group",
    title: "测试小组",
    createdBy: "u-me",
    dmKey: null,
    lastSeq: 3,
    createdAt: NOW,
    updatedAt: NOW,
    lastReadSeq: 0,
    unreadCount: 3,
    lastMessage: message({ body: "看下这个", senderId: "u-bob" }),
    ...over,
  });

  it("群里显示发送者前缀，自己发的显示「你：」", () => {
    const nameOf = (id: string): string => (id === "u-bob" ? "包冲" : id);
    expect(conversationPreview(conversation(), "u-me", nameOf)).toEqual({
      text: "看下这个",
      prefix: "包冲:",
    });
    expect(
      conversationPreview(
        conversation({ lastMessage: message({ senderId: "u-me", body: "好" }) }),
        "u-me",
        nameOf,
      ),
    ).toEqual({ text: "好", prefix: "you:" });
  });

  it("单聊不加发送者前缀；撤回的消息预览成已撤回", () => {
    const nameOf = (id: string): string => id;
    expect(conversationPreview(conversation({ kind: "dm" }), "u-me", nameOf).prefix).toBe("");
    expect(
      conversationPreview(
        conversation({ lastMessage: message({ body: "", deletedAt: NOW }) }),
        "u-me",
        nameOf,
      ).text,
    ).toBe("已撤回");
  });

  it("没有消息时预览为空（新会话）", () => {
    expect(conversationPreview(conversation({ lastMessage: null }), "u-me", () => "x")).toEqual({
      text: "",
      prefix: "",
    });
  });
});

describe("会话标题", () => {
  const dm = (dmKey: string | null): ImConversationSummary =>
    ({
      id: "c1",
      orgId: "org",
      kind: "dm",
      title: null,
      createdBy: "u-me",
      dmKey,
      lastSeq: 0,
      createdAt: NOW,
      updatedAt: NOW,
      lastReadSeq: 0,
      unreadCount: 0,
      lastMessage: null,
    }) as ImConversationSummary;

  it("单聊标题是对方姓名（与谁先发起无关）", () => {
    const nameOf = (id: string): string | undefined => (id === "u-bob" ? "包冲" : undefined);
    expect(conversationTitle(dm("u-bob:u-me"), "u-me", nameOf, "会话")).toBe("包冲");
    expect(conversationTitle(dm("u-me:u-bob"), "u-me", nameOf, "会话")).toBe("包冲");
  });

  it("拿不到姓名时退回对方 id，而不是显示「未命名」", () => {
    expect(conversationTitle(dm("u-bob:u-me"), "u-me", () => undefined, "会话")).toBe("u-bob");
  });

  it("群聊用群名；没有群名才退回占位文案", () => {
    const group = { ...dm(null), kind: "group" as const, title: "测试小组" };
    expect(conversationTitle(group, "u-me", () => undefined, "未命名会话")).toBe("测试小组");
    expect(
      conversationTitle({ ...group, title: null }, "u-me", () => undefined, "未命名会话"),
    ).toBe("未命名会话");
  });
});

describe("时间线组织", () => {
  it("跨天插日期分隔，未读位置插未读分隔，连续同一人合并头部", () => {
    const rows = buildTimeline({
      selfUserId: "u-me",
      unreadAfterSeq: 1,
      now: NOW,
      dayLabels: labels,
      messages: [
        message({ id: "m1", seq: 1, senderId: "u-bob", createdAt: NOW - 86_400_000 }),
        message({ id: "m2", seq: 2, senderId: "u-bob", createdAt: NOW }),
        message({ id: "m3", seq: 3, senderId: "u-bob", createdAt: NOW + 60_000 }),
        message({ id: "m4", seq: 4, senderId: "u-me", createdAt: NOW + 120_000 }),
      ],
    });
    expect(rows.map((row) => row.kind)).toEqual([
      "day",
      "message",
      "day",
      "unread",
      "message",
      "message",
      "message",
    ]);
    const messageRows = rows.filter((row) => row.kind === "message") as Array<
      Extract<(typeof rows)[number], { kind: "message" }>
    >;
    expect(messageRows.map((row) => row.message.id)).toEqual(["m1", "m2", "m3", "m4"]);
    // 昨天的单条：自己一组
    expect(messageRows[0].gap).toBe("normal");
    // 今天的第一条（跨天分隔之后）必然重新显示头部
    expect(messageRows[1].showHeader).toBe(true);
    // 同一个人 60 秒内的第二条：合并头部、紧贴
    expect(messageRows[2].showHeader).toBe(false);
    expect(messageRows[2].gap).toBe("tight");
    // 换人 + 是自己发的：重新显示头部，且判为自己一侧
    expect(messageRows[3]).toMatchObject({ mine: true, showHeader: true, gap: "normal" });
  });

  it("间隔超过 5 分钟的同一个人重新显示头部", () => {
    const rows = buildTimeline({
      selfUserId: "u-me",
      now: NOW,
      dayLabels: labels,
      messages: [
        message({ id: "m1", seq: 1, createdAt: NOW }),
        message({ id: "m2", seq: 2, createdAt: NOW + 6 * 60_000 }),
      ],
    });
    const messages = rows.filter((row) => row.kind === "message");
    expect(messages[1]).toMatchObject({ showHeader: true, gap: "normal" });
  });

  it("不给 unreadAfterSeq 时没有未读分隔线（不是所有打开都需要）", () => {
    const rows = buildTimeline({
      selfUserId: "u-me",
      now: NOW,
      dayLabels: labels,
      messages: [message({ id: "m1", seq: 1 })],
    });
    expect(rows.some((row) => row.kind === "unread")).toBe(false);
  });
});
