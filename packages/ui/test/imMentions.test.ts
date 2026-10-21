import { describe, expect, it } from "vitest";
import type { ImMessage } from "@zcode/shared";
import { MENTION_ALL_ID, mentionsMe, splitMentions } from "@/im/imMentions.js";

const message = (over: Partial<ImMessage> = {}): ImMessage => ({
  id: "m1",
  conversationId: "c1",
  seq: 1,
  senderId: "u-a",
  kind: "text",
  body: "@辛晓华 看一下",
  clientMsgId: null,
  createdAt: 1,
  editedAt: null,
  deletedAt: null,
  replyTo: null,
  reactions: [],
  mentions: [],
  pinnedAt: null,
  ...over,
});

describe("@提及", () => {
  it("切开正文并把 @ 片段标出来", () => {
    const segments = splitMentions("请 @辛晓华 和 @吕岳阳 看下", "辛晓华");
    expect(segments.filter((s) => s.mention).map((s) => s.text)).toEqual(["@辛晓华", "@吕岳阳"]);
    expect(segments.find((s) => s.text === "@辛晓华")?.mine).toBe(true);
    expect(segments.find((s) => s.text === "@吕岳阳")?.mine).toBe(false);
  });

  it("@全体 对每个人都算提到我", () => {
    expect(splitMentions("@全体 注意", "辛晓华")[0]).toMatchObject({ mention: true, mine: true });
    expect(mentionsMe(message({ mentions: [MENTION_ALL_ID] }), "u-me")).toBe(true);
  });

  it("邮箱/普通 @ 不吃掉整段，且没有 @ 时原样返回", () => {
    expect(splitMentions("我的邮箱 a@b.com 在这", "辛晓华").filter((s) => s.mention)).toHaveLength(
      0,
    );
    expect(splitMentions("普通一段话", null)).toEqual([
      { text: "普通一段话", mention: false, mine: false },
    ]);
  });

  it("是否提到我看服务端记的 id，不看正文", () => {
    expect(mentionsMe(message({ mentions: ["u-me"] }), "u-me")).toBe(true);
    // 正文写着我的名字，但服务端没记 id（例如引用别人的话）→ 不算提到我
    expect(mentionsMe(message({ body: "@u-me 是别人说的" }), "u-me")).toBe(false);
    expect(mentionsMe(message({ mentions: ["u-me"] }), null)).toBe(false);
  });
});
