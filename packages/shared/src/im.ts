import { z } from "zod";

/**
 * UWork 基础 IM 的协议单一来源（桌面主进程 / 渲染层 / 手机页共用）。
 *
 * 服务端实现是 ucas-proxy 仓库的 `services/msgbus`，REST 与 WS 面见
 * `specs/messaging-and-channels.md` §2.3。**改这里就要同步改服务端**，
 * 反之亦然——两边靠这份类型对齐，没有代码生成。
 *
 * 两条约定：
 * - 所有时间戳是 **epoch 毫秒**（SQLite 的 CURRENT_TIMESTAMP 只到秒，会让"最近会话"排序抖动）。
 * - `seq` 是会话内单调递增的序号：客户端用 `since=<seq>` 增量补洞，靠 `clientMsgId` 做幂等重发。
 */

export type ImConversationKind = "dm" | "group" | "channel";
export type ImMessageKind = "text" | "attachment" | "system" | "card";

/** 引用块：被回复那条的摘要。由服务端 LEFT JOIN 出来，客户端不必自己回查（原消息可能没加载）。 */
export interface ImReplyPreview {
  messageId: string;
  senderId: string;
  /** 原消息正文（撤回/删除后为空串）。 */
  body: string;
  kind: ImMessageKind;
  deleted: boolean;
}

/** 表情回应（服务端聚合）：`userIds` 是"谁点了"，客户端据此算自己的高亮。 */
export interface ImReaction {
  emoji: string;
  count: number;
  userIds: string[];
}

/**
 * 历史检索的一页。**按 seq 倒序**（最近命中优先），`before` 继续往前翻，
 * 语义与历史分页一致——命中要能"跳到那一条"，所以返回的是完整消息而不是摘要片段。
 */
export interface ImSearchPage {
  conversationId: string;
  messages: ImMessage[];
  hasMore: boolean;
}

/** 全局检索的结果：消息 + 每条所属会话的信息（列表要显示"来自哪个会话"）。 */
export interface ImGlobalSearchPage {
  messages: ImMessage[];
  conversations: Record<string, { title: string | null; kind: ImConversationKind }>;
  hasMore: boolean;
}

/** 一条收藏：消息本身 + 它所在的会话。 */
export interface ImBookmarkItem {
  message: ImMessage;
  conversationTitle: string | null;
  conversationKind: ImConversationKind;
}

/** 附件元数据（字节在服务端卷上，客户端用带鉴权的 fetch 取）。 */
export interface ImAttachment {
  id: string;
  conversationId: string;
  uploaderId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}

/**
 * `kind === "attachment"` 时 body 的载荷。
 *
 * 除了 id 还带上 name/mime/size：这几个是**发送方上传完就已知**的展示信息，
 * 带上就不必为每条附件消息再回查一次服务端。它们是展示用（服务端只校验 id 归属），
 * 真正下发的字节与 content-type 由下载端点按库里那份给。
 */
export interface ImAttachmentBody {
  attachmentId: string;
  name: string;
  mime: string;
  size: number;
}

export function parseImAttachmentBody(body: string): ImAttachmentBody | null {
  try {
    const value = JSON.parse(body) as {
      attachmentId?: unknown;
      name?: unknown;
      mime?: unknown;
      size?: unknown;
    };
    if (typeof value.attachmentId !== "string") return null;
    return {
      attachmentId: value.attachmentId,
      name: typeof value.name === "string" && value.name ? value.name : "file",
      mime: typeof value.mime === "string" && value.mime ? value.mime : "application/octet-stream",
      size: typeof value.size === "number" && Number.isFinite(value.size) ? value.size : 0,
    };
  } catch {
    return null;
  }
}

/** 图片能否内联预览：只认位图，SVG 不内联（脚本向量）。 */
export function isInlineImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(mime);
}

export interface ImMessage {
  id: string;
  conversationId: string;
  seq: number;
  senderId: string;
  kind: ImMessageKind;
  /** 撤回后为 `""`（保留 tombstone：seq 不回收，历史上仍留一行删除标记）。 */
  body: string;
  /** `kind === "system"` / `kind === "card"` 时 body 是 JSON 载荷（见对应的 parse 函数）。 */
  clientMsgId: string | null;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  replyTo: ImReplyPreview | null;
  reactions: ImReaction[];
  /** 被 @ 到的人 id；`all` 表示 @全体。不从正文解析——改名会让解析失效。 */
  mentions: string[];
  /** 置顶时间（null = 未置顶）。 */
  pinnedAt: number | null;
}

/**
 * 系统消息载荷。**正文不入库成人话**：服务端只记"谁做了什么"，文案由客户端按语言渲染
 * （仓库有 zh-CN / en-US 两套文案，把中文写进库里等于把语言钉死在服务端）。
 */
export type ImSystemAction =
  | { action: "group_created"; actorId: string; title: string }
  | { action: "members_added"; actorId: string; memberIds: string[] }
  | { action: "member_removed"; actorId: string; memberId: string }
  | { action: "member_left"; actorId: string }
  | { action: "title_changed"; actorId: string; title: string };

export * from "./imCard.js";

/** 云端的一份工作汇报（`GET /api/reports`）。 */
export interface ImWorkReport {
  id: string;
  orgId: string;
  authorId: string;
  periodKey: string;
  title: string;
  summary: string;
  content: string;
  problems: string;
  type: string;
  tags: string[];
  attachmentIds: string[];
  recipientIds: string[];
  status: "submitted" | "reviewed" | "returned";
  messageId: string | null;
  submittedAt: number;
  reviewedBy: string | null;
  reviewedAt: number | null;
}

export interface ImReportList {
  reports: ImWorkReport[];
}

export function parseImSystemMessage(body: string): ImSystemAction | null {
  try {
    const value = JSON.parse(body) as { action?: unknown };
    if (!value || typeof value !== "object" || typeof value.action !== "string") return null;
    return value as ImSystemAction;
  } catch {
    return null;
  }
}

/** 会话成员（右栏成员面板用：姓名由客户端查通讯录，部门/职位一起带回来省一次往返）。 */
export interface ImMember {
  id: string;
  role: "owner" | "member";
  joinedAt: number;
  online: boolean;
}

export interface ImConversation {
  id: string;
  orgId: string;
  kind: ImConversationKind;
  title: string | null;
  createdBy: string;
  /** DM 幂等键（两个成员排序后拼接），非 DM 为 null。 */
  dmKey: string | null;
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface ImConversationSummary extends ImConversation {
  lastReadSeq: number;
  unreadCount: number;
  /** 未读里"被 @ 到"的条数：列表给红色角标，与普通未读区分。 */
  mentionCount: number;
  lastMessage: ImMessage | null;
}

/** 通讯录条目（来自企业网关的 /api/directory/users，已按 IM 白名单过滤）。 */
export interface ImDirectoryUser {
  id: string;
  name: string | null;
  avatar: string | null;
  department: string | null;
  /** 服务端切好的部门 token，客户端不要自己再切一次。 */
  departments: string[];
  position: string | null;
}

/**
 * 准入查询结果。403 与 503 在客户端要区别对待：
 * - `enabled === false` 且 `reason === "not_in_allowlist" | "org_not_enabled"` → 不渲染入口；
 * - 请求本身失败（网络/503）→ 视为"暂时未知"，不要把入口永久隐藏。
 */
export interface ImEntitlement {
  enabled: boolean;
  via: "user" | "department" | null;
  reason: "org_not_enabled" | "not_in_allowlist" | null;
}

/** WS 关闭码：客户端据此区分"令牌问题/没权限/服务不可用"，见 msgbus src/ws.ts。 */
export const IM_CLOSE_CODES = {
  protocol: 4400,
  unauthorized: 4401,
  forbidden: 4403,
  unavailable: 4503,
} as const;

const imReplyPreviewSchema = z.object({
  messageId: z.string(),
  senderId: z.string(),
  body: z.string(),
  kind: z.enum(["text", "attachment", "system", "card"]),
  deleted: z.boolean(),
});

const imReactionSchema = z.object({
  emoji: z.string(),
  count: z.number(),
  userIds: z.array(z.string()).default([]),
});

const imMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number(),
  senderId: z.string(),
  kind: z.enum(["text", "attachment", "system", "card"]),
  body: z.string(),
  clientMsgId: z.string().nullable(),
  createdAt: z.number(),
  editedAt: z.number().nullable(),
  deletedAt: z.number().nullable(),
  replyTo: imReplyPreviewSchema.nullable().default(null),
  reactions: z.array(imReactionSchema).default([]),
  mentions: z.array(z.string()).default([]),
  pinnedAt: z.number().nullable().default(null),
});

const imConversationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  kind: z.enum(["dm", "group", "channel"]),
  title: z.string().nullable(),
  createdBy: z.string(),
  dmKey: z.string().nullable(),
  lastSeq: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const imConversationSummarySchema = imConversationSchema.extend({
  lastReadSeq: z.number(),
  unreadCount: z.number(),
  lastMessage: imMessageSchema.nullable(),
});

/** 服务端 → 客户端帧。用 schema 校验而不是直接 JSON.parse：认不出的帧必须被丢弃，不能让脏数据进 UI。 */
export const imServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    userId: z.string(),
    orgId: z.string(),
    serverTime: z.number(),
  }),
  z.object({
    type: z.literal("sent"),
    clientMsgId: z.string().nullable(),
    message: imMessageSchema,
    duplicated: z.boolean(),
  }),
  z.object({ type: z.literal("message"), conversationId: z.string(), message: imMessageSchema }),
  /** 消息被改（编辑正文、置顶/取消置顶）：整条替换，客户端不必猜改了哪一部分。 */
  z.object({
    type: z.literal("message_updated"),
    conversationId: z.string(),
    message: imMessageSchema,
  }),
  z.object({
    type: z.literal("read"),
    conversationId: z.string(),
    userId: z.string(),
    seq: z.number(),
  }),
  z.object({
    type: z.literal("message_deleted"),
    conversationId: z.string(),
    messageId: z.string(),
  }),
  /** 表情回应变化：带上该条消息**聚合后**的回声（谁点了、几个），客户端直接替换这一条的。 */
  z.object({
    type: z.literal("message_reactions"),
    conversationId: z.string(),
    messageId: z.string(),
    reactions: z.array(imReactionSchema),
  }),
  /** 正在输入：瞬时事件，不落库、不进 seq；客户端自己做超时。 */
  z.object({
    type: z.literal("typing"),
    conversationId: z.string(),
    userId: z.string(),
  }),
  /** 在线状态变化：只广播"谁上线/下线了"，成员列表本身另外拉（避免每帧带全量名单）。 */
  z.object({
    type: z.literal("presence"),
    conversationId: z.string(),
    userId: z.string(),
    online: z.boolean(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("pong"), serverTime: z.number() }),
]);
export type ImServerFrame = z.infer<typeof imServerFrameSchema>;

export type ImClientFrame =
  | { type: "auth"; token: string }
  | {
      type: "send";
      conversationId: string;
      body: string;
      clientMsgId?: string;
      /** 引用的原消息 id（同会话）；服务端校验归属，跨会话引用直接拒。 */
      replyToId?: string;
      /** 被 @ 到的人（同会话成员）或 `all`；服务端逐个校验，提到外人会被拒。 */
      mentionIds?: string[];
      /**
       * 消息类型：客户端只能发 `text` 与 `attachment`。
       * **`system` 一律由服务端产生**——允许客户端指定就等于允许伪造"某某把群名改成了 X"。
       */
      kind?: "text" | "attachment";
    }
  | { type: "read"; conversationId: string; seq: number }
  /** 正在输入（节流后发送；服务端只转发给会话里的其他人）。 */
  | { type: "typing"; conversationId: string }
  | { type: "ping" };

/** 解析服务端帧；认不出返回 null（调用方记日志并忽略）。 */
export function parseImServerFrame(raw: string): ImServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = imServerFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * 由网关/msgbus 的 HTTP 基址推出 WS 地址。
 * 手机页与桌面都用同一份实现，避免两边各写一遍 http→ws 的替换逻辑。
 */
export function buildImWsUrl(baseUrl: string, path = "/ws"): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** 未读数只由服务端算好的 last_seq - last_read_seq 提供；这里只做越界保护。 */
export function normalizeUnreadCount(summary: Pick<ImConversationSummary, "unreadCount">): number {
  return Number.isFinite(summary.unreadCount) && summary.unreadCount > 0 ? summary.unreadCount : 0;
}
