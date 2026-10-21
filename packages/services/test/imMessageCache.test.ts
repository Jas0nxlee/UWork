import { describe, expect, it } from "vitest";
import type { ImMessage } from "@zcode/shared";
import { createImMessageCache, reactionsPatch, withdrawPatch } from "../src/im/imMessageCache.js";

const message = (over: Partial<ImMessage> = {}): ImMessage => ({
  id: "m1",
  conversationId: "c1",
  seq: 1,
  senderId: "u-lv",
  kind: "text",
  body: "一",
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

describe("消息缓存", () => {
  it("同一条消息再次进来是替换，不是追加（按 id 或 seq 都认）", () => {
    const cache = createImMessageCache();
    cache.upsert(message());
    cache.upsert(message({ id: "m1", seq: 1, body: "改过" }));
    expect(cache.list("c1")).toHaveLength(1);
    expect(cache.list("c1")[0]?.body).toBe("改过");

    cache.upsert(message({ id: "m-other", seq: 1 }));
    expect(cache.list("c1")).toHaveLength(1);
  });

  it("补洞插进来的旧消息会排到正确位置（乱序也不怕）", () => {
    const cache = createImMessageCache();
    cache.set("c1", [message({ id: "m5", seq: 5 })]);
    cache.upsertMany([message({ id: "m3", seq: 3 }), message({ id: "m7", seq: 7 })]);
    expect(cache.list("c1").map((item) => item.seq)).toEqual([3, 5, 7]);
  });

  it("往上翻页：旧页插到前面且仍按 seq 排序", () => {
    const cache = createImMessageCache();
    cache.set("c1", [message({ id: "m5", seq: 5 }), message({ id: "m6", seq: 6 })]);
    cache.prependOlder("c1", [message({ id: "m3", seq: 3 }), message({ id: "m4", seq: 4 })]);
    expect(cache.list("c1").map((item) => item.seq)).toEqual([3, 4, 5, 6]);
  });

  it("跳转窗口按 seq 去重合并（与已有消息重叠时不会出现两份）", () => {
    const cache = createImMessageCache();
    cache.set("c1", [message({ id: "m5", seq: 5, body: "旧" })]);
    cache.mergeWindow("c1", [
      message({ id: "m5", seq: 5, body: "新" }),
      message({ id: "m6", seq: 6 }),
    ]);
    const list = cache.list("c1");
    expect(list.map((item) => item.seq)).toEqual([5, 6]);
    expect(list[0]?.body).toBe("新");
  });

  it("replace/patch 对不存在的会话或消息是空操作（不会凭空造一条）", () => {
    const cache = createImMessageCache();
    cache.replace(message());
    cache.patch("c1", "m1", reactionsPatch([]));
    expect(cache.list("c1")).toHaveLength(0);
  });

  it("撤回只清正文与附件，保留「…已撤回」需要的元数据", () => {
    const patched = withdrawPatch(message({ body: "机密", kind: "attachment" }), 99);
    expect(patched.body).toBe("");
    expect(patched.deletedAt).toBe(99);
    expect(patched.senderId).toBe("u-lv");
    expect(patched.seq).toBe(1);
  });

  it("表情是整组替换（服务端给的是聚合结果）", () => {
    const patched = reactionsPatch([{ emoji: "👍", count: 2, userIds: ["a", "b"] }])(message());
    expect(patched.reactions).toEqual([{ emoji: "👍", count: 2, userIds: ["a", "b"] }]);
  });

  it("newestSeq 给补洞当起点：没缓存过就是 0", () => {
    const cache = createImMessageCache();
    expect(cache.newestSeq("c1")).toBe(0);
    cache.set("c1", [message({ seq: 4 }), message({ id: "m9", seq: 9 })]);
    expect(cache.newestSeq("c1")).toBe(9);
  });
});
