import { Emitter } from "@zcode/rpc";
import type { ImConversationSummary, ImEntitlement, ImMessage } from "@zcode/shared";
import type {
  IImService,
  ImConnectionStatus,
  ImMessagesView,
  ImRealtimeEvent,
  ImView,
} from "./contract.js";
import { createImCommands } from "./imCommands.js";
import { ImHttpError, type ImHttpClient } from "./imHttpClient.js";
import { createImMessageCache, reactionsPatch, withdrawPatch } from "./imMessageCache.js";
import { advanceSummaries, applyReadReceipt } from "./imSummary.js";
import { createImTransport, type ImSocketLike, type ImTransport } from "./imTransport.js";
import type { ImServerFrame } from "@zcode/shared";

/**
 * IM 服务门面：把 HTTP（真相来源）+ WS（实时投递）拼成一份客户端状态。
 *
 * 三条设计要点：
 * 1. **消息以服务端为准**：WS 帧只用来更新本地缓存，任何时候都能用 REST 重建（补洞靠 `since`）。
 * 2. **发送幂等**：每条消息带 `clientMsgId`，WS 超时或不在线就回退 HTTP——服务端按 id 去重，
 *    所以"重试"永远不会产生第二条消息。
 * 3. **重连即补洞**：连接恢复后逐个会话比对 `lastSeq` 与本地最大 seq，拉 `since` 补齐缺口。
 */
export interface ImServiceOptions {
  client: ImHttpClient;
  createSocket: (url: string) => ImSocketLike;
  resolveUrl: () => Promise<string | undefined>;
  resolveToken: () => Promise<string | undefined>;
  randomId?: () => string;
  sendTimeoutMs?: number;
  pageSize?: number;
  transport?: {
    heartbeatMs?: number;
    authTimeoutMs?: number;
    backoffMs?: (attempt: number) => number;
    timers?: {
      set: (callback: () => void, ms: number) => unknown;
      clear: (handle: unknown) => void;
    };
    now?: () => number;
  };
  log?: (level: "info" | "warn", message: string, detail?: unknown) => void;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export function createImService(options: ImServiceOptions): IImService {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const log = options.log ?? (() => {});
  const timers = options.transport?.timers ?? {
    set: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clear: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  };

  let entitlement: ImEntitlement | null = null;
  let conversations: ImConversationSummary[] = [];
  let connection: ImConnectionStatus = "idle";
  let lastError: string | null = null;
  const cache = createImMessageCache();
  const pendingSends = new Map<string, { resolve: (message: ImMessage) => void }>();
  let activeConversationId: string | null = null;
  /** 当前登录用户的 id：由 `ready` 帧带回，用来区分"自己发的"与"别人发的"。 */
  let selfUserId: string | null = null;

  const changed = new Emitter<ImView>();
  const realtime = new Emitter<ImRealtimeEvent>();

  function view(): ImView {
    return {
      entitlement: entitlement ? { ...entitlement } : null,
      conversations: conversations.map((c) => ({ ...c })),
      connection,
      lastError,
      selfUserId,
    };
  }

  function publish(): void {
    changed.fire(view());
  }

  /**
   * 把一条新消息折进会话列表（未读/提及规则见 `imSummary.ts`，那里是纯函数、有单测）。
   * 列表里没有这个会话（别人拉我进群）就先刷新，别让消息静默消失。
   */
  function updateSummary(message: ImMessage): void {
    if (!conversations.some((conversation) => conversation.id === message.conversationId)) {
      void refresh().catch(() => {});
      return;
    }
    const advanced = advanceSummaries(conversations, message, { selfUserId, activeConversationId });
    conversations = advanced.conversations;
    if (advanced.markReadSeq !== null) {
      // 正在看的会话：收到就顺手标已读（失败不回滚未读，下次打开会对齐）。
      void applyRead(message.conversationId, advanced.markReadSeq).catch(() => {});
    }
  }

  function handleFrame(frame: ImServerFrame): void {
    if (frame.type === "ready") {
      selfUserId = frame.userId;
      // 连接刚恢复：先跟服务端把列表对齐（未读/预览/提及都以服务端为准），再把丢线期间
      // 漏掉的消息补回时间线。顺序不能反——只补消息的话，界面会出现"时间线里有、会话行没未读"
      // 的错位（真机联调踩到：断网期间对方发 3 条，重连后时间线有 3 条、列表却一条未读都不亮）。
      void syncAfterReconnect();
      publish();
      return;
    }
    if (frame.type === "sent") {
      cache.upsert(frame.message);
      updateSummary(frame.message);
      const pending = frame.clientMsgId ? pendingSends.get(frame.clientMsgId) : undefined;
      if (pending && frame.clientMsgId) {
        pendingSends.delete(frame.clientMsgId);
        pending.resolve(frame.message);
      }
      publish();
      return;
    }
    if (frame.type === "message") {
      cache.upsert(frame.message);
      updateSummary(frame.message);
      realtime.fire({
        kind: "message",
        conversationId: frame.conversationId,
        message: frame.message,
      });
      publish();
      return;
    }
    if (frame.type === "read") {
      // 别的端替我读了：本地未读要跟着清（未读是每用户一个计数器，不是每设备一份）。
      if (frame.userId === selfUserId) {
        conversations = applyReadReceipt(conversations, frame.conversationId, frame.seq);
        publish();
      }
      realtime.fire({
        kind: "read",
        conversationId: frame.conversationId,
        userId: frame.userId,
        seq: frame.seq,
      });
      return;
    }
    if (frame.type === "message_updated") {
      cache.replace(frame.message);
      realtime.fire({
        kind: "message_updated",
        conversationId: frame.conversationId,
        message: frame.message,
      });
      publish();
      return;
    }
    if (frame.type === "message_deleted") {
      cache.patch(frame.conversationId, frame.messageId, (message) =>
        withdrawPatch(message, Date.now()),
      );
      realtime.fire({
        kind: "message_deleted",
        conversationId: frame.conversationId,
        messageId: frame.messageId,
      });
      publish();
      return;
    }
    if (frame.type === "message_reactions") {
      cache.patch(frame.conversationId, frame.messageId, reactionsPatch(frame.reactions));
      realtime.fire({
        kind: "message_reactions",
        conversationId: frame.conversationId,
        messageId: frame.messageId,
        reactions: frame.reactions,
      });
      publish();
      return;
    }
    if (frame.type === "typing") {
      realtime.fire({
        kind: "typing",
        conversationId: frame.conversationId,
        userId: frame.userId,
      });
      return;
    }
    if (frame.type === "presence") {
      // 在线状态不进 view（它按会话维度、且变化频繁），只转发给订阅者：成员面板自己维护这份状态。
      realtime.fire({
        kind: "presence",
        conversationId: frame.conversationId,
        userId: frame.userId,
        online: frame.online,
      });
      return;
    }
    if (frame.type === "error") {
      lastError = `${frame.code}: ${frame.message}`;
      log("warn", "IM 服务端返回错误帧", frame);
      publish();
    }
  }

  const transport: ImTransport = createImTransport({
    resolveUrl: options.resolveUrl,
    resolveToken: options.resolveToken,
    createSocket: options.createSocket,
    onFrame: handleFrame,
    onStatusChange: (status) => {
      connection = status;
      if (status === "online") lastError = null;
      publish();
    },
    ...options.transport,
    log,
  });

  /** 断线补洞：对每个已知会话拉 `since=本地最大 seq`。 */
  async function catchUp(): Promise<void> {
    for (const summary of conversations) {
      const since = cache.newestSeq(summary.id);
      if (summary.lastSeq <= since) continue;
      try {
        const missing = await options.client.messages({ conversationId: summary.id, since });
        cache.upsertMany(missing);
        if (missing.length) {
          // 补洞发独立事件：UI 静默插入，不当作新消息弹通知。
          realtime.fire({ kind: "catch_up", conversationId: summary.id, messages: missing });
          publish();
        }
      } catch (error) {
        log("warn", "IM 补洞失败", {
          conversationId: summary.id,
          message: (error as Error).message,
        });
      }
    }
  }

  /**
   * 重连后的对齐：先刷新列表（未读/预览/提及全部以服务端为准），再补消息、再把正在看的会话标已读。
   *
   * 为什么不"只补消息 + 本地累加未读"：那条路要求"每条消息都恰好被本地处理过一次"，
   * 断线期间漏掉的帧、半开连接里丢掉的帧都会破坏它，而刷新是幂等的自愈。
   * 正在看的会话最后标已读，是为了不出现"我明明看着它、列表却挂着一个未读"。
   */
  async function syncAfterReconnect(): Promise<void> {
    try {
      await refresh();
    } catch (error) {
      log("warn", "IM 重连后刷新列表失败", { message: (error as Error).message });
    }
    await catchUp();
    if (activeConversationId) {
      const newest = cache.list(activeConversationId).at(-1);
      if (newest) {
        await applyRead(activeConversationId, newest.seq).catch(() => {
          // 已读上报失败不回滚未读：下次打开会对齐。
        });
      }
    }
  }

  async function refresh(): Promise<ImView> {
    lastError = null;
    try {
      entitlement = await options.client.entitlement();
    } catch (error) {
      // 503/网络失败都不代表"没权限"：保留上一次结果，只记错误，入口不要因此消失。
      const httpError = error as ImHttpError;
      lastError = httpError.message ?? String(error);
      if (httpError.status === 403)
        entitlement = { enabled: false, via: null, reason: "not_in_allowlist" };
      publish();
      return view();
    }

    if (!entitlement.enabled) {
      transport.stop();
      conversations = [];
      publish();
      return view();
    }

    try {
      conversations = await options.client.conversations();
    } catch (error) {
      lastError = (error as Error).message ?? String(error);
    }
    if (!transport.isOnline()) transport.start();
    publish();
    return view();
  }

  /** 上报已读并同步本地未读（WS 顺手通知其他端；失败由调用方决定要不要提示）。 */
  async function applyRead(conversationId: string, seq: number): Promise<number> {
    const lastReadSeq = await options.client.markRead({ conversationId, seq });
    conversations = conversations.map((c) =>
      c.id === conversationId ? { ...c, lastReadSeq, unreadCount: 0 } : c,
    );
    transport.send({ type: "read", conversationId, seq: lastReadSeq });
    publish();
    return lastReadSeq;
  }

  async function openConversation(conversationId: string): Promise<ImMessagesView> {
    activeConversationId = conversationId;
    const messages = await options.client.messages({ conversationId, limit: pageSize });
    cache.set(conversationId, messages);
    const newest = messages.at(-1);
    if (newest) {
      await options.client.markRead({ conversationId, seq: newest.seq }).catch((error) => {
        log("warn", "上报已读失败", { message: (error as Error).message });
      });
      conversations = conversations.map((c) =>
        c.id === conversationId ? { ...c, lastReadSeq: newest.seq, unreadCount: 0 } : c,
      );
      publish();
    }
    return { conversationId, messages, hasMore: messages.length >= pageSize };
  }

  async function loadOlder(
    conversationId: string,
    before: number,
    limit?: number,
  ): Promise<ImMessagesView> {
    const page = await options.client.messages({
      conversationId,
      before,
      limit: limit ?? pageSize,
    });
    cache.prependOlder(conversationId, page);
    return { conversationId, messages: page, hasMore: page.length >= (limit ?? pageSize) };
  }

  async function sendMessage(input: {
    conversationId: string;
    body: string;
    clientMsgId?: string;
    replyToId?: string;
    kind?: "text" | "attachment";
    mentionIds?: string[];
  }): Promise<ImMessage> {
    // 调用方带了 id 就用它的：UI 侧"发送失败 → 重试"必须复用同一个 id，
    // 否则"请求其实到了服务端、只是回包丢了"这种情况会变成两条消息。
    const clientMsgId = input.clientMsgId ?? randomId();
    if (transport.isOnline()) {
      const viaWs = await new Promise<ImMessage | null>((resolve) => {
        const handle = timers.set(() => {
          pendingSends.delete(clientMsgId);
          resolve(null);
        }, sendTimeoutMs);
        pendingSends.set(clientMsgId, {
          resolve: (message) => {
            timers.clear(handle);
            resolve(message);
          },
        });
        const accepted = transport.send({
          type: "send",
          conversationId: input.conversationId,
          body: input.body,
          clientMsgId,
          ...(input.replyToId ? { replyToId: input.replyToId } : {}),
          ...(input.kind && input.kind !== "text" ? { kind: input.kind } : {}),
          ...(input.mentionIds && input.mentionIds.length > 0
            ? { mentionIds: input.mentionIds }
            : {}),
        });
        if (!accepted) {
          timers.clear(handle);
          pendingSends.delete(clientMsgId);
          resolve(null);
        }
      });
      if (viaWs) return viaWs;
      // 超时/发送失败 → 回退 HTTP；同一个 clientMsgId 让服务端幂等去重。
    }
    const message = await options.client.send({
      conversationId: input.conversationId,
      body: input.body,
      clientMsgId,
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      ...(input.kind && input.kind !== "text" ? { kind: input.kind } : {}),
      ...(input.mentionIds && input.mentionIds.length > 0 ? { mentionIds: input.mentionIds } : {}),
    });
    cache.upsert(message);
    updateSummary(message);
    publish();
    return message;
  }

  const commands = createImCommands({
    client: options.client,
    cache,
    publish,
    refresh,
    emitDeleted: (conversationId, messageId) =>
      realtime.fire({ kind: "message_deleted", conversationId, messageId }),
    applyConversation: (conversation) => {
      conversations = conversations.map((item) =>
        item.id === conversation.id ? { ...item, ...conversation } : item,
      );
      publish();
    },
    sendTyping: (conversationId) => transport.send({ type: "typing", conversationId }),
    now: () => Date.now(),
  });

  return {
    async getView() {
      return view();
    },
    refresh,
    async searchDirectory(query) {
      return options.client.directory(query);
    },
    openConversation,
    loadOlder,
    sendMessage,
    async markRead(input) {
      await applyRead(input.conversationId, input.seq);
    },
    ...commands,
    onDidChange: changed.event,
    onRealtime: realtime.event,
  };
}
