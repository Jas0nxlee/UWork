import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImConversationSummary, ImMessage } from "@zcode/shared";
import { createImService } from "../src/im/imService.js";
import { ImHttpError, type ImHttpClient } from "../src/im/imHttpClient.js";
import { createImTransport, type ImSocketLike } from "../src/im/imTransport.js";

/** 可控的假 socket：记录发出去的帧，并允许测试驱动 open/message/close。 */
class FakeSocket implements ImSocketLike {
  readyState = 1;
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(type, list);
  }
  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
  serverClose(code: number): void {
    this.emit("close", { code });
  }
  deliver(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }
}

function makeSocketFactory(): {
  sockets: FakeSocket[];
  createSocket: (url: string) => ImSocketLike;
} {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  };
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("IM 连接管理", () => {
  it("建连后先发 auth 帧，收到 ready 才算在线", async () => {
    vi.useFakeTimers();
    const { sockets, createSocket } = makeSocketFactory();
    const transport = createImTransport({
      resolveUrl: async () => "ws://im.test/ws",
      resolveToken: async () => "token-1",
      createSocket,
      onFrame: () => {},
    });
    transport.start();
    await flush();
    expect(sockets).toHaveLength(1);
    expect(transport.status()).toBe("connecting");

    // auth 帧在 open 之后才发（浏览器语义下 open 前 send 会抛错）。
    sockets[0].emit("open");
    expect(sockets[0].frames()[0]).toEqual({ type: "auth", token: "token-1" });
    sockets[0].deliver({ type: "ready", userId: "u-1", orgId: "org-bj", serverTime: 1 });
    expect(transport.status()).toBe("online");
    expect(transport.isOnline()).toBe(true);
    transport.stop();
  });

  it("在线时周期发 ping；收到 pong 就继续在线", async () => {
    vi.useFakeTimers();
    const { sockets, createSocket } = makeSocketFactory();
    const transport = createImTransport({
      resolveUrl: async () => "ws://im.test/ws",
      resolveToken: async () => "t",
      createSocket,
      onFrame: () => {},
    });
    transport.start();
    await flush();
    sockets[0].emit("open");
    sockets[0].deliver({ type: "ready", userId: "u-1", orgId: "org-bj", serverTime: 1 });

    await vi.advanceTimersByTimeAsync(25_000);
    expect(sockets[0].frames().some((f) => f.type === "ping")).toBe(true);
    sockets[0].deliver({ type: "pong", serverTime: 2 });

    await vi.advanceTimersByTimeAsync(25_000);
    expect(transport.status()).toBe("online");
    expect(sockets).toHaveLength(1);
    transport.stop();
  });

  it("心跳连续两个周期没有 pong → 判定链路已死并重建（半开连接不会自己 close）", async () => {
    vi.useFakeTimers();
    const { sockets, createSocket } = makeSocketFactory();
    const transport = createImTransport({
      resolveUrl: async () => "ws://im.test/ws",
      resolveToken: async () => "t",
      createSocket,
      onFrame: () => {},
    });
    transport.start();
    await flush();
    sockets[0].emit("open");
    sockets[0].deliver({ type: "ready", userId: "u-1", orgId: "org-bj", serverTime: 1 });

    await vi.advanceTimersByTimeAsync(80_000); // 三个心跳周期，全程没有 pong
    expect(transport.isOnline()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000); // 退避后重连
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    transport.stop();
  });

  it("4403（不在白名单）是终态：不重连", async () => {
    vi.useFakeTimers();
    const { sockets, createSocket } = makeSocketFactory();
    const statuses: string[] = [];
    const transport = createImTransport({
      resolveUrl: async () => "ws://im.test/ws",
      resolveToken: async () => "t",
      createSocket,
      onFrame: () => {},
      onStatusChange: (status) => statuses.push(status),
    });
    transport.start();
    await flush();
    sockets[0].emit("open");
    sockets[0].serverClose(4403);
    expect(transport.status()).toBe("forbidden");
    expect(statuses).toContain("forbidden");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1); // 没有重连尝试
    transport.stop();
  });

  it("4503（服务端拒绝服务）会退避重连；离线时 send 返回 false", async () => {
    vi.useFakeTimers();
    const { sockets, createSocket } = makeSocketFactory();
    const transport = createImTransport({
      resolveUrl: async () => "ws://im.test/ws",
      resolveToken: async () => "t",
      createSocket,
      onFrame: () => {},
    });
    transport.start();
    await flush();
    sockets[0].emit("open");
    sockets[0].serverClose(4503);
    expect(transport.status()).toBe("unavailable");
    expect(transport.send({ type: "ping" })).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    transport.stop();
  });

  it("认不出的帧被忽略且不影响连接", async () => {
    vi.useFakeTimers();
    const { sockets, createSocket } = makeSocketFactory();
    const frames: unknown[] = [];
    const transport = createImTransport({
      resolveUrl: async () => "ws://im.test/ws",
      resolveToken: async () => "t",
      createSocket,
      onFrame: (frame) => frames.push(frame),
    });
    transport.start();
    await flush();
    sockets[0].emit("open");
    sockets[0].deliver({ type: "ready", userId: "u-1", orgId: "org-bj", serverTime: 1 });
    sockets[0].emit("message", { data: "{ 这不是 JSON" });
    sockets[0].emit("message", { data: JSON.stringify({ type: "unknown-frame" }) });

    expect(frames).toEqual([{ type: "ready", userId: "u-1", orgId: "org-bj", serverTime: 1 }]);
    expect(transport.status()).toBe("online");
    transport.stop();
  });
});

// ---------------------------------------------------------------------------
// 服务门面
// ---------------------------------------------------------------------------

const conversation = (over: Partial<ImConversationSummary> = {}): ImConversationSummary => ({
  id: "c-1",
  orgId: "org-bj",
  kind: "dm",
  title: null,
  createdBy: "u-me",
  dmKey: "u-me:u-peer",
  lastSeq: 1,
  createdAt: 1,
  updatedAt: 1,
  lastReadSeq: 0,
  unreadCount: 0,
  lastMessage: null,
  ...over,
});

const message = (over: Partial<ImMessage> = {}): ImMessage => ({
  id: "m-1",
  conversationId: "c-1",
  seq: 1,
  senderId: "u-peer",
  kind: "text",
  body: "hi",
  clientMsgId: null,
  createdAt: 1,
  editedAt: null,
  deletedAt: null,
  ...over,
});

function makeClient(over: Partial<ImHttpClient> = {}): ImHttpClient {
  return {
    entitlement: vi.fn(async () => ({ enabled: true, via: "department" as const, reason: null })),
    directory: vi.fn(async () => []),
    conversations: vi.fn(async () => [conversation()]),
    messages: vi.fn(async () => [message()]),
    send: vi.fn(async () => message()),
    members: vi.fn(async () => ["u-me", "u-peer"]),
    markRead: vi.fn(async () => 1),
    createConversation: vi.fn(async () => conversation() as never),
    rename: vi.fn(async () => conversation() as never),
    addMembers: vi.fn(async () => {}),
    removeMember: vi.fn(async () => {}),
    withdraw: vi.fn(async () => {}),
    ...over,
  } as ImHttpClient;
}

function makeService(client: ImHttpClient, socketFactory = makeSocketFactory()) {
  const service = createImService({
    client,
    createSocket: socketFactory.createSocket,
    resolveUrl: async () => "ws://im.test/ws",
    resolveToken: async () => "t",
    randomId: () => "client-msg-1",
  });
  return { service, ...socketFactory };
}

describe("重连与多端（真机联调抓到的那两条）", () => {
  it("重连（ready）时先刷新列表再补洞：断网期间别人的消息，未读要跟着服务端亮起来", async () => {
    vi.useFakeTimers();
    // 第一次 refresh 时未读 0；"断网期间"对端发了 3 条，服务端算出来是 3
    let serverUnread = 0;
    const missing = [2, 3, 4].map((seq) => message({ id: `m-${seq}`, seq, conversationId: "c-1" }));
    const client = makeClient({
      conversations: vi.fn(async () => [
        conversation({ lastSeq: 4, unreadCount: serverUnread, lastMessage: missing[2] ?? null }),
      ]),
      messages: vi.fn(async () => (serverUnread === 0 ? [message()] : missing)),
    });
    const { service, sockets } = makeService(client);
    await service.refresh();
    await flush(); // 建连是异步的：socket 要等 resolveUrl/resolveToken 之后才出现
    sockets[0].emit("open");
    sockets[0].deliver({ type: "ready", userId: "u-me", orgId: "org-bj", serverTime: 1 });
    await flush();
    expect((await service.getView()).conversations[0]?.unreadCount).toBe(0);
    const conversationsCallsBefore = (client.conversations as Mock).mock.calls.length;

    // 断网：连接被掐断 + 期间对端发了 3 条
    serverUnread = 3;
    sockets[0].serverClose(1006);
    await vi.advanceTimersByTimeAsync(2_000); // 退避后重连
    const next = sockets[sockets.length - 1];
    next.emit("open");
    next.deliver({ type: "ready", userId: "u-me", orgId: "org-bj", serverTime: 2 });
    await flush();

    // ① 重连要重新对齐列表（未读/预览以服务端为准）
    expect((client.conversations as Mock).mock.calls.length).toBeGreaterThan(
      conversationsCallsBefore,
    );
    expect((await service.getView()).conversations[0]?.unreadCount).toBe(3);
    // ② 并且把缺口补进消息缓存（since = 本地已有的最大 seq）
    expect(client.messages).toHaveBeenCalledWith({ conversationId: "c-1", since: 1 });
  });

  it("同一用户的另一台设备读了会话：本机未读立刻清零（未读是每用户一份）", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { service, sockets } = makeService(client);
    await service.refresh();
    await flush(); // 建连是异步的：socket 要等 resolveUrl/resolveToken 之后才出现
    sockets[0].emit("open");
    sockets[0].deliver({ type: "ready", userId: "u-me", orgId: "org-bj", serverTime: 1 });
    await flush();

    // 对端来一条 → 未读 1
    sockets[0].deliver({
      type: "message",
      conversationId: "c-1",
      message: message({ id: "m-2", seq: 2 }),
    });
    await flush();
    expect((await service.getView()).conversations[0]?.unreadCount).toBe(1);

    // 另一台设备（同一 userId）上报已读 → 本机跟着清
    sockets[0].deliver({ type: "read", conversationId: "c-1", userId: "u-me", seq: 2 });
    await flush();
    const summary = (await service.getView()).conversations[0];
    expect(summary?.unreadCount).toBe(0);
    expect(summary?.mentionCount ?? 0).toBe(0);
    expect(summary?.lastReadSeq).toBe(2);

    // 别人的已读不影响我的未读（各自一份）
    sockets[0].deliver({
      type: "message",
      conversationId: "c-1",
      message: message({ id: "m-3", seq: 3 }),
    });
    await flush();
    sockets[0].deliver({ type: "read", conversationId: "c-1", userId: "u-peer", seq: 3 });
    await flush();
    expect((await service.getView()).conversations[0]?.unreadCount).toBe(1);
  });
});

describe("IM 服务门面", () => {
  it("refresh：有权限时拉会话列表并建立连接", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { service, sockets } = makeService(client);
    const view = await service.refresh();
    await flush();

    expect(view.entitlement?.enabled).toBe(true);
    expect(view.conversations).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    sockets[0].emit("open");
    expect(sockets[0].frames()[0]).toEqual({ type: "auth", token: "t" });
  });

  it("准入接口 503 不会被当成没权限（入口不会因此消失）", async () => {
    vi.useFakeTimers();
    let unavailable = false;
    const client = makeClient({
      entitlement: vi.fn(async () => {
        if (unavailable) throw new ImHttpError(503, "im_unavailable", "IM unavailable");
        return { enabled: true, via: "department" as const, reason: null };
      }),
    });
    const { service } = makeService(client);
    await service.refresh();

    unavailable = true;
    const view = await service.refresh();
    expect(view.entitlement?.enabled).toBe(true); // 保留上一次的结论
    expect(view.lastError).toContain("IM unavailable");
  });

  it("准入接口 403 才判定为没权限，并停掉连接", async () => {
    vi.useFakeTimers();
    const client = makeClient({
      entitlement: vi.fn(async () => {
        throw new ImHttpError(403, "im_not_allowed", "not allowed");
      }),
    });
    const { service } = makeService(client);
    const view = await service.refresh();
    expect(view.entitlement).toEqual({ enabled: false, via: null, reason: "not_in_allowlist" });
    expect(view.connection).toBe("idle");
  });

  it("在线发送走 WS，由 sent 帧返回权威消息", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { service, sockets } = makeService(client);
    await service.refresh();
    await flush();
    sockets[0].emit("open");
    sockets[0].deliver({ type: "ready", userId: "u-me", orgId: "org-bj", serverTime: 1 });
    expect(sockets[0].frames().some((f) => f.type === "auth")).toBe(true);

    const pending = service.sendMessage({ conversationId: "c-1", body: "hello" });
    await flush();
    const sentFrame = sockets[0].frames().find((f) => f.type === "send") as { clientMsgId: string };
    expect(sentFrame.body).toBe("hello");
    sockets[0].deliver({
      type: "sent",
      clientMsgId: sentFrame.clientMsgId,
      message: message({ id: "m-9", seq: 2, body: "hello", senderId: "u-me" }),
      duplicated: false,
    });

    const result = await pending;
    expect(result.id).toBe("m-9");
    expect(client.send).not.toHaveBeenCalled();
  });

  it("不在线时回退 HTTP，且带上同一个 clientMsgId（服务端幂等去重）", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { service } = makeService(client);
    await service.sendMessage({ conversationId: "c-1", body: "offline" });
    expect(client.send).toHaveBeenCalledWith({
      conversationId: "c-1",
      body: "offline",
      clientMsgId: "client-msg-1",
    });
  });

  it("调用方指定的 clientMsgId 原样使用：UI 重试不会变成两条消息", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { service } = makeService(client);
    // 离线走 HTTP
    await service.sendMessage({ conversationId: "c-1", body: "again", clientMsgId: "ui-fixed-id" });
    expect(client.send).toHaveBeenCalledWith({
      conversationId: "c-1",
      body: "again",
      clientMsgId: "ui-fixed-id",
    });

    // 在线走 WS：帧里也必须是同一个 id，服务端才认得出这是重试
    const { service: online, sockets } = makeService(makeClient());
    await online.refresh();
    await flush();
    sockets[0].emit("open");
    sockets[0].deliver({ type: "ready", userId: "u-me", orgId: "org-bj", serverTime: 1 });
    const pending = online.sendMessage({
      conversationId: "c-1",
      body: "again",
      clientMsgId: "ui-fixed-id",
    });
    await flush();
    const frame = sockets[0].frames().find((f) => f.type === "send") as { clientMsgId: string };
    expect(frame.clientMsgId).toBe("ui-fixed-id");
    sockets[0].deliver({
      type: "sent",
      clientMsgId: "ui-fixed-id",
      message: message({ id: "m-7", seq: 3, body: "again", senderId: "u-me" }),
      duplicated: false,
    });
    expect((await pending).id).toBe("m-7");
  });

  it("收到 message 帧：未读 +1、lastMessage 更新、发出实时事件", async () => {
    vi.useFakeTimers();
    const client = makeClient({
      conversations: vi.fn(async () => [conversation({ lastSeq: 1, unreadCount: 0 })]),
      // 这个用例只关心实时帧：补洞调用返回空，避免混入 catch_up 事件。
      messages: vi.fn(async () => []),
    });
    const { service, sockets } = makeService(client);
    const events: unknown[] = [];
    service.onRealtime((event) => events.push(event));
    await service.refresh();
    await flush();
    sockets[0].emit("open");
    sockets[0].deliver({ type: "ready", userId: "u-me", orgId: "org-bj", serverTime: 1 });

    sockets[0].deliver({
      type: "message",
      conversationId: "c-1",
      message: message({ seq: 2, body: "新消息" }),
    });
    const view = await service.getView();
    expect(view.conversations[0].unreadCount).toBe(1);
    expect(view.conversations[0].lastMessage?.body).toBe("新消息");
    expect(view.conversations[0].lastSeq).toBe(2);
    expect(events).toEqual([
      { kind: "message", conversationId: "c-1", message: expect.objectContaining({ seq: 2 }) },
    ]);
  });

  it("重连后补洞：拉回来的历史消息发 catch_up 而不是 message（不刷通知）", async () => {
    vi.useFakeTimers();
    const client = makeClient({
      conversations: vi.fn(async () => [conversation({ lastSeq: 3 })]),
      messages: vi.fn(async () => [
        message({ seq: 1 }),
        message({ id: "m-2", seq: 2 }),
        message({ id: "m-3", seq: 3 }),
      ]),
    });
    const { service, sockets } = makeService(client);
    const events: Array<{ kind: string; messages?: unknown[] }> = [];
    service.onRealtime((event) => events.push(event));
    await service.refresh();
    await flush();
    sockets[0].emit("open");
    sockets[0].deliver({ type: "ready", userId: "u-me", orgId: "org-bj", serverTime: 1 });
    await flush();

    expect(client.messages).toHaveBeenCalledWith({ conversationId: "c-1", since: 0 });
    expect(events.map((e) => e.kind)).toEqual(["catch_up"]);
    expect(events[0].messages).toHaveLength(3);
  });

  it("openConversation 拉最新一页并上报已读", async () => {
    vi.useFakeTimers();
    const client = makeClient({
      messages: vi.fn(async () => [message({ seq: 1 }), message({ id: "m-2", seq: 2 })]),
    });
    const { service } = makeService(client);
    await service.refresh();
    const opened = await service.openConversation("c-1");
    expect(opened.messages).toHaveLength(2);
    expect(client.markRead).toHaveBeenCalledWith({ conversationId: "c-1", seq: 2 });
    const view = await service.getView();
    expect(view.conversations[0].unreadCount).toBe(0);
  });

  it("listMembers 透传服务端成员列表（群设置要用）", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { service } = makeService(client);
    await service.refresh();
    await expect(service.listMembers("c-1")).resolves.toEqual(["u-me", "u-peer"]);
    expect(client.members).toHaveBeenCalledWith("c-1");
  });

  it("撤回：调 HTTP 之后发 message_deleted 事件（本地与远端只有一条更新路径）", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const { service } = makeService(client);
    const events: Array<{ kind: string; messageId?: string }> = [];
    service.onRealtime((event) => events.push(event));
    await service.refresh();

    await service.withdrawMessage({ conversationId: "c-1", messageId: "m-7" });
    expect(client.withdraw).toHaveBeenCalledWith({ conversationId: "c-1", messageId: "m-7" });
    expect(events).toEqual([{ kind: "message_deleted", conversationId: "c-1", messageId: "m-7" }]);
  });

  it("撤回失败时向上抛且不改本地状态（UI 据此提示，不静默吞掉）", async () => {
    vi.useFakeTimers();
    const client = makeClient({
      withdraw: vi.fn(async () => {
        throw new ImHttpError(403, "forbidden", "only sender can delete");
      }),
    });
    const { service } = makeService(client);
    const events: unknown[] = [];
    service.onRealtime((event) => events.push(event));
    await service.refresh();

    await expect(
      service.withdrawMessage({ conversationId: "c-1", messageId: "m-8" }),
    ).rejects.toThrow(/only sender can delete/);
    expect(events).toEqual([]);
  });
});

describe("表情回应与正在输入（客户端接线）", () => {
  it("message_reactions 帧替换该条消息的回声并转发实时事件", async () => {
    vi.useFakeTimers();
    const client = makeClient({
      conversations: vi.fn(async () => [conversation({ lastSeq: 1, unreadCount: 0 })]),
      messages: vi.fn(async () => [message({ id: "m-1", seq: 1 })]),
    });
    const { service, sockets } = makeService(client);
    const events: Array<{ kind: string; messageId?: string }> = [];
    service.onRealtime((event) => events.push(event as { kind: string; messageId?: string }));
    await service.refresh();
    await flush();
    sockets[0].emit("open");
    sockets[0].deliver({ type: "ready", userId: "u-me", orgId: "org-bj", serverTime: 1 });
    await service.openConversation("c-1");

    sockets[0].deliver({
      type: "message_reactions",
      conversationId: "c-1",
      messageId: "m-1",
      reactions: [{ emoji: "👍", count: 2, userIds: ["u-me", "u-other"] }],
    });
    // 面板靠这个事件更新那一条；载荷里带的就是服务端聚合后的结果（count + 谁点的）
    expect(events.filter((e) => e.kind === "message_reactions")).toEqual([
      {
        kind: "message_reactions",
        conversationId: "c-1",
        messageId: "m-1",
        reactions: [{ emoji: "👍", count: 2, userIds: ["u-me", "u-other"] }],
      },
    ]);
  });

  it("typing 帧只转成实时事件，不写消息缓存", async () => {
    vi.useFakeTimers();
    const client = makeClient({
      conversations: vi.fn(async () => [conversation({ lastSeq: 0, unreadCount: 0 })]),
      messages: vi.fn(async () => []),
    });
    const { service, sockets } = makeService(client);
    const events: Array<{ kind: string; userId?: string }> = [];
    service.onRealtime((event) => events.push(event as { kind: string; userId?: string }));
    await service.refresh();
    await flush();
    sockets[0].emit("open");
    sockets[0].deliver({ type: "ready", userId: "u-me", orgId: "org-bj", serverTime: 1 });

    sockets[0].deliver({ type: "typing", conversationId: "c-1", userId: "u-other" });
    expect(events.filter((e) => e.kind === "typing")).toHaveLength(1);
    const view = await service.openConversation("c-1");
    expect(view.messages).toEqual([]);
  });

  it("sendTyping 发出 typing 帧；离线时静默失败不抛错", async () => {
    vi.useFakeTimers();
    const { service, sockets } = makeService(makeClient());
    await service.refresh();
    await flush();
    sockets[0].emit("open");
    sockets[0].deliver({ type: "ready", userId: "u-me", orgId: "org-bj", serverTime: 1 });
    service.sendTyping("c-1");
    expect(sockets[0].frames().some((f) => f.type === "typing")).toBe(true);

    // 断开后调用不应该抛（它是瞬时事件，不是关键路径）
    sockets[0].serverClose(1006);
    expect(() => service.sendTyping("c-1")).not.toThrow();
  });
});
