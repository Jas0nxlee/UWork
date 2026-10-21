import { describe, expect, it } from "vitest";
import type { ImMessage } from "@zcode/shared";
import {
  createOutboxItem,
  markOutboxFailed,
  markOutboxSending,
  outboxForConversation,
  reconcileOutbox,
} from "@/im/imOutbox.js";
import { splitHighlight } from "@/im/imSearch.js";
import {
  applyConversationPreferences,
  parseImPreferences,
  preferenceOf,
  serializeImPreferences,
  sumUnread,
  togglePreference,
} from "@/im/imPreferences.js";
import type { ImConversationSummary } from "@zcode/shared";

const message = (over: Partial<ImMessage> = {}): ImMessage => ({
  id: "m1",
  conversationId: "c1",
  seq: 1,
  senderId: "u-a",
  kind: "text",
  body: "hello world",
  clientMsgId: null,
  createdAt: 1,
  editedAt: null,
  deletedAt: null,
  replyTo: null,
  reactions: [],
  ...over,
});

const conversation = (over: Partial<ImConversationSummary> = {}): ImConversationSummary => ({
  id: "c1",
  orgId: "org",
  kind: "group",
  title: "g",
  createdBy: "u-a",
  dmKey: null,
  lastSeq: 1,
  createdAt: 1,
  updatedAt: 1,
  lastReadSeq: 0,
  unreadCount: 0,
  lastMessage: null,
  ...over,
});

describe("出站队列", () => {
  it("按 clientMsgId 认领服务端回包，不看正文", () => {
    const item = createOutboxItem({
      clientMsgId: "local-1",
      conversationId: "c1",
      body: "hi",
      now: 10,
    });
    expect(item.status).toBe("sending");
    // 服务端可能对正文做过规整（去空格），所以只能按 id 认领
    expect(reconcileOutbox([item], { clientMsgId: "local-1" })).toEqual([]);
    expect(reconcileOutbox([item], { clientMsgId: null })).toEqual([item]);
    expect(reconcileOutbox([item], { clientMsgId: "local-2" })).toEqual([item]);
  });

  it("失败标记只影响那一条，重试回到发送中", () => {
    const one = createOutboxItem({ clientMsgId: "a", conversationId: "c1", body: "1", now: 1 });
    const two = createOutboxItem({ clientMsgId: "b", conversationId: "c1", body: "2", now: 2 });
    const failed = markOutboxFailed([one, two], "a");
    expect(failed.map((item) => item.status)).toEqual(["failed", "sending"]);
    expect(markOutboxSending(failed, "a").map((item) => item.status)).toEqual([
      "sending",
      "sending",
    ]);
  });

  it("只取当前会话的待发项，并按时间排序", () => {
    const items = [
      createOutboxItem({ clientMsgId: "b", conversationId: "c1", body: "2", now: 20 }),
      createOutboxItem({ clientMsgId: "x", conversationId: "c2", body: "别处", now: 5 }),
      createOutboxItem({ clientMsgId: "a", conversationId: "c1", body: "1", now: 10 }),
    ];
    expect(outboxForConversation(items, "c1").map((item) => item.clientMsgId)).toEqual(["a", "b"]);
  });
});

describe("检索高亮切片", () => {
  it("切分高亮片段：大小写不敏感，含首尾残留", () => {
    expect(splitHighlight("Hello world", "world")).toEqual([
      { text: "Hello ", match: false },
      { text: "world", match: true },
    ]);
    // 每处命中都高亮；扫描不重叠，光标推进到命中之后
    expect(splitHighlight("aaa", "A")).toEqual([
      { text: "a", match: true },
      { text: "a", match: true },
      { text: "a", match: true },
    ]);
    expect(splitHighlight("abc", "")).toEqual([{ text: "abc", match: false }]);
  });
});

describe("会话偏好（置顶 / 静音）", () => {
  it("解析坏数据不抛错，忽略空壳项", () => {
    expect(parseImPreferences(null)).toEqual({});
    expect(parseImPreferences("{ not json")).toEqual({});
    expect(
      parseImPreferences('{"c1":{"pinned":false,"muted":false},"c2":{"pinned":true}}'),
    ).toEqual({
      c2: { pinned: true, muted: false },
    });
    expect(
      parseImPreferences(serializeImPreferences({ c1: { pinned: true, muted: false } })),
    ).toEqual({ c1: { pinned: true, muted: false } });
  });

  it("开关取反；两个都关掉时不留空壳", () => {
    let prefs = togglePreference({}, "c1", "pinned");
    expect(preferenceOf(prefs, "c1")).toEqual({ pinned: true, muted: false });
    prefs = togglePreference(prefs, "c1", "muted");
    expect(preferenceOf(prefs, "c1")).toEqual({ pinned: true, muted: true });
    prefs = togglePreference(prefs, "c1", "pinned");
    expect(preferenceOf(prefs, "c1")).toEqual({ pinned: false, muted: true });
    prefs = togglePreference(prefs, "c1", "muted");
    expect(prefs).toEqual({});
  });

  it("排序：置顶优先，其余按最后活动倒序", () => {
    const sorted = applyConversationPreferences(
      [
        conversation({ id: "old", updatedAt: 10 }),
        conversation({ id: "new", updatedAt: 30 }),
        conversation({ id: "pin", updatedAt: 1 }),
      ],
      { pin: { pinned: true, muted: false } },
    );
    expect(sorted.map((item) => item.id)).toEqual(["pin", "new", "old"]);
  });

  it("总未读排除静音会话", () => {
    const list = [
      conversation({ id: "a", unreadCount: 3 }),
      conversation({ id: "b", unreadCount: 5 }),
    ];
    expect(sumUnread(list, {})).toBe(8);
    expect(sumUnread(list, { b: { pinned: false, muted: true } })).toBe(3);
  });
});
