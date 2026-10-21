import type {
  ImConversation,
  ImReportList,
  ImWorkReport,
  ImDirectoryUser,
  ImEntitlement,
  ImAttachment,
  ImBookmarkItem,
  ImGlobalSearchPage,
  ImMember,
  ImMessage,
  ImReaction,
  ImSearchPage,
  ImConversationSummary,
} from "@zcode/shared";

/**
 * IM 的 HTTP 面（msgbus 的 REST）。
 *
 * 门禁语义要原样往上传：403 = 明确不在白名单；503 = IM 暂不可用（快照缺失/失配/过期）。
 * 客户端据此区分"渲染不渲染入口"与"提示稍后重试"，不要把 503 当成没权限。
 */
export class ImHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImHttpError";
  }
}

export interface ImHttpClientOptions {
  /** 形如 `https://pivot.ucas.com.cn:23090`（网关基址；IM 与它同源部署）。 */
  resolveBaseUrl: () => Promise<string | undefined>;
  resolveToken: () => Promise<string | undefined>;
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export interface ImHttpClient {
  entitlement(): Promise<ImEntitlement>;
  directory(query: string): Promise<ImDirectoryUser[]>;
  conversations(): Promise<ImConversationSummary[]>;
  messages(input: {
    conversationId: string;
    since?: number;
    before?: number;
    limit?: number;
  }): Promise<ImMessage[]>;
  send(input: {
    conversationId: string;
    body: string;
    clientMsgId: string;
    /** 引用的原消息 id（同会话）；服务端校验归属。 */
    replyToId?: string;
    kind?: "text" | "attachment";
    mentionIds?: string[];
  }): Promise<ImMessage>;
  /** 群设置用：会话成员 id（姓名由客户端用目录解析）。 */
  members(conversationId: string): Promise<string[]>;
  /** 编辑消息（只有发送者；服务端会校验）。 */
  editMessage(input: {
    conversationId: string;
    messageId: string;
    body: string;
  }): Promise<ImMessage>;
  /** 置顶/取消置顶（会话成员都能操作）。 */
  setMessagePinned(input: {
    conversationId: string;
    messageId: string;
    pinned: boolean;
  }): Promise<ImMessage>;
  /** 会话内已置顶的消息。 */
  pinnedMessages(conversationId: string): Promise<ImMessage[]>;
  /** 收藏/取消收藏（每人一份）。 */
  setBookmark(input: { messageId: string; bookmarked: boolean }): Promise<{ bookmarked: boolean }>;
  /** 我的收藏。 */
  bookmarks(): Promise<ImBookmarkItem[]>;
  /** 提交一份工作汇报：服务端落库并往单聊投一张卡片（正文与附件都在服务端）。 */
  submitReport(input: {
    periodKey: string;
    title: string;
    summary?: string;
    content?: string;
    problems?: string;
    type?: string;
    tags?: string[];
    attachmentIds?: string[];
    recipientIds: string[];
  }): Promise<{ report: ImWorkReport; message: ImMessage }>;
  /** 我发的 + 我收到的汇报（可按周期/作者过滤）。 */
  reports(input?: { periodKey?: string; authorId?: string; limit?: number }): Promise<ImReportList>;
  report(reportId: string): Promise<{ report: ImWorkReport }>;
  /** 审核动作：已阅（reviewed）/ 退回（returned，必须带 comment）。 */
  reviewWorkItem(input: {
    itemId: string;
    status: "reviewed" | "returned";
    comment?: string;
  }): Promise<{ itemId: string; status: string }>;

  /** **全局检索**：我所在的所有会话。 */
  searchAll(input: { query: string; before?: number; limit?: number }): Promise<ImGlobalSearchPage>;
  /** 全历史检索（服务端搜，不是"在已加载的那页里找"）。 */
  searchMessages(input: {
    conversationId: string;
    query: string;
    before?: number;
    limit?: number;
  }): Promise<ImSearchPage>;
  /** 成员面板用：角色 + 在线（一次请求拿全，避免"名单 + 在线"两次往返不一致）。 */
  memberDetails(conversationId: string): Promise<ImMember[]>;
  /** 表情回应：加/取消都返回该条消息聚合后的结果。 */
  addReaction(input: { messageId: string; emoji: string }): Promise<ImReaction[]>;
  removeReaction(input: { messageId: string; emoji: string }): Promise<ImReaction[]>;
  /** 附件：原始字节上传（文件名/类型走请求头，不引 multipart 依赖）。 */
  uploadAttachment(input: {
    conversationId: string;
    name: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<ImAttachment>;
  /** 附件下载：成员校验在服务端，这里只带令牌取字节。 */
  downloadAttachment(attachmentId: string): Promise<Uint8Array>;
  markRead(input: { conversationId: string; seq: number }): Promise<number>;
  createConversation(input: {
    kind: "dm" | "group" | "channel";
    memberIds: string[];
    title?: string;
  }): Promise<ImConversation>;
  rename(input: { conversationId: string; title: string }): Promise<ImConversation>;
  addMembers(input: { conversationId: string; memberIds: string[] }): Promise<void>;
  removeMember(input: { conversationId: string; memberId: string }): Promise<void>;
  withdraw(input: { conversationId: string; messageId: string }): Promise<void>;
}

export function createImHttpClient(options: ImHttpClientOptions): ImHttpClient {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = await options.resolveBaseUrl();
    if (!baseUrl) throw new ImHttpError(0, "not_configured", "IM endpoint is not configured");
    const token = await options.resolveToken();
    if (!token) throw new ImHttpError(401, "unauthorized", "not signed in");

    const response = await options.fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
        authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      let code = `http_${response.status}`;
      let message = `IM request failed: ${response.status}`;
      try {
        // **两种错误信封都要认**（真机踩到：只认一种会把原因吞成"IM request failed: 400"）：
        // 会话/消息类路由是 `{error, message}`，工作项类路由是 JSON:API 的 `{errors:[{code,detail}]}`。
        // 丢掉 detail 的代价是用户只看到状态码，而服务端其实说得很清楚（例：author cannot review own item）。
        const body = (await response.json()) as {
          error?: string;
          message?: string;
          errors?: { code?: string; detail?: string }[];
        };
        const first = Array.isArray(body.errors) ? body.errors[0] : undefined;
        if (typeof first?.code === "string" && first.code) code = first.code;
        else if (typeof body.error === "string" && body.error) code = body.error;
        if (typeof first?.detail === "string" && first.detail) message = first.detail;
        else if (typeof body.message === "string" && body.message) message = body.message;
        else if (typeof body.error === "string" && body.error)
          message = `${body.error} (${response.status})`;
      } catch {
        // 非 JSON 错误体：保留状态码信息
      }
      throw new ImHttpError(response.status, code, message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const query = (params: Record<string, string | number | undefined>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : "";
  };

  return {
    async entitlement() {
      const body = await request<ImEntitlement>("/api/im/entitlement");
      return { enabled: body.enabled, via: body.via, reason: body.reason };
    },
    async directory(search) {
      const body = await request<{ users: ImDirectoryUser[] }>(
        `/api/directory/users${query({ q: search })}`,
      );
      return body.users;
    },
    async conversations() {
      const body = await request<{ conversations: ImConversationSummary[] }>("/api/conversations");
      return body.conversations;
    },
    async messages(input) {
      const body = await request<{ messages: ImMessage[] }>(
        `/api/conversations/${encodeURIComponent(input.conversationId)}/messages${query({
          since: input.since,
          before: input.before,
          limit: input.limit,
        })}`,
      );
      return body.messages;
    },
    async send(input) {
      const body = await request<{ message: ImMessage }>(
        `/api/conversations/${encodeURIComponent(input.conversationId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            body: input.body,
            clientMsgId: input.clientMsgId,
            ...(input.replyToId ? { replyToId: input.replyToId } : {}),
            ...(input.kind && input.kind !== "text" ? { kind: input.kind } : {}),
            ...(input.mentionIds && input.mentionIds.length > 0
              ? { mentionIds: input.mentionIds }
              : {}),
          }),
        },
      );
      return body.message;
    },
    async markRead(input) {
      const body = await request<{ lastReadSeq: number }>(
        `/api/conversations/${encodeURIComponent(input.conversationId)}/read`,
        { method: "POST", body: JSON.stringify({ seq: input.seq }) },
      );
      return body.lastReadSeq;
    },
    async createConversation(input) {
      const body = await request<{ conversation: ImConversation }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return body.conversation;
    },
    async rename(input) {
      const body = await request<{ conversation: ImConversation }>(
        `/api/conversations/${encodeURIComponent(input.conversationId)}`,
        { method: "PATCH", body: JSON.stringify({ title: input.title }) },
      );
      return body.conversation;
    },
    async addMembers(input) {
      await request(`/api/conversations/${encodeURIComponent(input.conversationId)}/members`, {
        method: "POST",
        body: JSON.stringify({ memberIds: input.memberIds }),
      });
    },
    async members(conversationId) {
      const body = await request<{ members: string[] }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/members`,
      );
      return body.members;
    },
    async editMessage(input) {
      const body = await request<{ message: ImMessage }>(
        `/api/conversations/${encodeURIComponent(input.conversationId)}/messages/${encodeURIComponent(input.messageId)}`,
        { method: "PATCH", body: JSON.stringify({ body: input.body }) },
      );
      return body.message;
    },
    async setMessagePinned(input) {
      const body = await request<{ message: ImMessage }>(
        `/api/messages/${encodeURIComponent(input.messageId)}/pin`,
        {
          method: "POST",
          body: JSON.stringify({ conversationId: input.conversationId, pinned: input.pinned }),
        },
      );
      return body.message;
    },
    async pinnedMessages(conversationId) {
      const body = await request<{ messages: ImMessage[] }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/pinned`,
      );
      return body.messages;
    },
    async setBookmark(input) {
      return request<{ bookmarked: boolean }>(
        `/api/messages/${encodeURIComponent(input.messageId)}/bookmark`,
        { method: "POST", body: JSON.stringify({ bookmarked: input.bookmarked }) },
      );
    },
    async bookmarks() {
      const body = await request<{ items: ImBookmarkItem[] }>("/api/bookmarks");
      return body.items;
    },
    async submitReport(input) {
      return request<{ report: ImWorkReport; message: ImMessage }>("/api/reports", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    async reports(input = {}) {
      const params = new URLSearchParams();
      if (input.periodKey) params.set("period", input.periodKey);
      if (input.authorId) params.set("author", input.authorId);
      if (input.limit) params.set("limit", String(input.limit));
      const query = params.toString();
      return request<ImReportList>(`/api/reports${query ? `?${query}` : ""}`);
    },
    async report(reportId) {
      return request<{ report: ImWorkReport }>(`/api/reports/${encodeURIComponent(reportId)}`);
    },
    /**
     * 审核动作（卡片上的「已阅 / 退回」）。**授权一律由服务端判**——非审核人会拿到 403，
     * 客户端只把它显示出来，不做"我猜我能点"的预判（见 specs/messaging-and-channels.md §12.18）。
     */
    async reviewWorkItem(input) {
      const body = await request<{ data: { id: string; attributes: { status: string } } }>(
        `/api/work-items/${encodeURIComponent(input.itemId)}/review`,
        {
          method: "POST",
          body: JSON.stringify({
            status: input.status,
            ...(input.comment ? { comment: input.comment } : {}),
          }),
        },
      );
      return { itemId: body.data.id, status: body.data.attributes.status };
    },
    async searchAll(input) {
      const params = new URLSearchParams({ q: input.query });
      if (input.before !== undefined) params.set("before", String(input.before));
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      return request<ImGlobalSearchPage>(`/api/messages/search?${params.toString()}`);
    },
    async searchMessages(input) {
      const params = new URLSearchParams({ q: input.query });
      if (input.before !== undefined) params.set("before", String(input.before));
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      const body = await request<{ messages: ImMessage[]; hasMore: boolean }>(
        `/api/conversations/${encodeURIComponent(input.conversationId)}/messages/search?${params.toString()}`,
      );
      return {
        conversationId: input.conversationId,
        messages: body.messages,
        hasMore: body.hasMore,
      };
    },
    async addReaction(input) {
      const body = await request<{ reactions: ImReaction[] }>(
        `/api/messages/${encodeURIComponent(input.messageId)}/reactions`,
        { method: "POST", body: JSON.stringify({ emoji: input.emoji }) },
      );
      return body.reactions;
    },
    async removeReaction(input) {
      const body = await request<{ reactions: ImReaction[] }>(
        `/api/messages/${encodeURIComponent(input.messageId)}/reactions/${encodeURIComponent(input.emoji)}`,
        { method: "DELETE" },
      );
      return body.reactions;
    },
    async uploadAttachment(input) {
      const baseUrl = await options.resolveBaseUrl();
      const token = await options.resolveToken();
      const response = await options.fetchImpl(
        `${baseUrl}/api/conversations/${encodeURIComponent(input.conversationId)}/attachments`,
        {
          method: "POST",
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            "content-type": "application/octet-stream",
            "x-file-name": encodeURIComponent(input.name),
            "x-file-mime": input.mime || "application/octet-stream",
          },
          body: input.bytes as unknown as RequestInit["body"],
        },
      );
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ImHttpError(response.status, "upload_failed", text.slice(0, 200));
      }
      const body = (await response.json()) as { attachment: ImAttachment };
      return body.attachment;
    },
    async downloadAttachment(attachmentId) {
      const baseUrl = await options.resolveBaseUrl();
      const token = await options.resolveToken();
      const response = await options.fetchImpl(
        `${baseUrl}/api/attachments/${encodeURIComponent(attachmentId)}`,
        { headers: token ? { authorization: `Bearer ${token}` } : {} },
      );
      if (!response.ok) {
        throw new ImHttpError(response.status, "download_failed", "attachment download failed");
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async memberDetails(conversationId) {
      const body = await request<{ details?: ImMember[]; members: string[] }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/members`,
      );
      // 老服务端没有 details 字段：退回"只有 id、状态未知"，不要因此让成员面板打不开。
      return (
        body.details ??
        body.members.map((id) => ({ id, role: "member" as const, joinedAt: 0, online: false }))
      );
    },
    async removeMember(input) {
      await request(
        `/api/conversations/${encodeURIComponent(input.conversationId)}/members/${encodeURIComponent(input.memberId)}`,
        { method: "DELETE" },
      );
    },
    async withdraw(input) {
      await request(
        `/api/conversations/${encodeURIComponent(input.conversationId)}/messages/${encodeURIComponent(input.messageId)}`,
        { method: "DELETE" },
      );
    },
  };
}
