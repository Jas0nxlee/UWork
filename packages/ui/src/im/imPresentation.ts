import type { ImConversationSummary, ImMessage } from "@zcode/shared";

/**
 * IM 界面的展示逻辑（纯函数，可单测）。
 *
 * 这里刻意把"成熟 IM 的组织方式"固化下来：会话行要有头像/名称/预览/时间/未读五项，
 * 消息流要有日期分隔、连续消息合并、未读分隔线。组件只负责摆位置，规则都在这里，
 * 这样以后加频道/话题时只需要扩这里，不用重新调界面。
 */

/** 头像取色：同一 id 永远同色（成熟 IM 都这么做，颜色本身不承载语义）。 */
const AVATAR_TONES = [
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
];

export function avatarTone(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100000;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? AVATAR_TONES[0] ?? "bg-muted text-foreground";
}

/** 姓名缩写：中文取后两字（"欧阳修" → "阳修"），英文取首字母（"alice zhang" → "AZ"）。 */
export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  if (/^[\u4e00-\u9fa5]/.test(trimmed)) {
    return trimmed.length <= 2 ? trimmed : trimmed.slice(-2);
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "";
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? first;
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase() || "?";
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" });
const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/** 时间文案需要的三种标签；调用方从 i18n 取，规则层不碰具体语言。 */
export interface ImTimeLabels {
  today: string;
  yesterday: string;
  weekdays: string[];
}

/** 会话行右上角的时间：今天给时刻，昨天给"昨天"，本周给周几，更早给日期。 */
export function formatListTime(timestamp: number, now: number, labels: ImTimeLabels): string {
  const dayDiff = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000);
  if (dayDiff <= 0) return timeFormatter.format(timestamp);
  if (dayDiff === 1) return labels.yesterday;
  if (dayDiff < 7) return labels.weekdays[new Date(timestamp).getDay()] ?? "";
  return dateFormatter.format(timestamp);
}

/**
 * 消息行头部的时间：只给时刻。
 * 日期已经由分隔线表达，这里再写一遍"昨天"就是重复——Slack/Teams 的消息头也是纯时刻。
 */
export function formatClockTime(timestamp: number): string {
  return timeFormatter.format(timestamp);
}

/** 消息流里的日期分隔标签：本周给"今天/昨天/周几"，更早给完整日期。 */
export function formatDayDivider(timestamp: number, now: number, labels: ImTimeLabels): string {
  const dayDiff = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000);
  if (dayDiff <= 0) return labels.today;
  if (dayDiff === 1) return labels.yesterday;
  if (dayDiff < 7) return labels.weekdays[new Date(timestamp).getDay()] ?? "";
  return fullDateFormatter.format(timestamp);
}

/** 会话行的预览文案：自己的消息加"你："前缀（企微/微信的组织方式）。 */
export function conversationPreview(
  conversation: ImConversationSummary,
  selfUserId: string | null,
  nameOf: (id: string) => string | undefined,
): { text: string; prefix: string } {
  const message = conversation.lastMessage;
  if (!message) return { text: "", prefix: "" };
  const text = message.deletedAt !== null ? "已撤回" : message.body;
  if (message.senderId === selfUserId) return { text, prefix: "you:" };
  if (conversation.kind === "dm") return { text, prefix: "" };
  const sender = nameOf(message.senderId);
  return { text, prefix: sender ? `${sender.split(/\s+/)[0]}:` : "" };
}

/** DM 的对方 id：dmKey 是排序后的两个成员 id（服务端存的），去掉自己就是对方。 */
export function dmPeerId(
  conversation: Pick<ImConversationSummary, "kind" | "dmKey">,
  selfUserId: string | null,
): string | undefined {
  if (conversation.kind !== "dm" || !conversation.dmKey) return undefined;
  return conversation.dmKey.split(":").find((id) => id !== selfUserId);
}

/** 会话标题：群/频道用群名，单聊用对方姓名（拿不到名字时退回 id）。 */
export function conversationTitle(
  conversation: ImConversationSummary,
  selfUserId: string | null,
  nameOf: (id: string) => string | undefined,
  untitled: string,
): string {
  if (conversation.title) return conversation.title;
  const peer = dmPeerId(conversation, selfUserId);
  if (!peer) return untitled;
  return nameOf(peer) ?? peer;
}

/** 会话副标题：单聊显示对方部门（成熟 IM 会在标题下给一行上下文）。 */
export function conversationSubtitle(
  conversation: ImConversationSummary,
  selfUserId: string | null,
  infoOf: (id: string) => { department?: string | null } | undefined,
): string {
  if (conversation.kind !== "dm") return "";
  const peer = dmPeerId(conversation, selfUserId);
  return (peer ? infoOf(peer)?.department : null) ?? "";
}

export type ImTimelineRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "unread"; key: string; label: string }
  /** 系统消息：居中一行，不带头像/姓名，且**打断分组**（它属于时间线本身，不属于某个人）。 */
  | { kind: "system"; key: string; message: ImMessage }
  | {
      kind: "message";
      key: string;
      message: ImMessage;
      mine: boolean;
      /** 是否显示头像与发送者名（连续同一人的消息只显示第一条）。 */
      showHeader: boolean;
      /** 与上一条的间距级别：同组紧贴，跨组留白。 */
      gap: "tight" | "normal";
    };

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * 把消息序列组织成"成熟 IM 的时间线"：日期分隔 + 未读分隔 + 连续消息合并。
 * `unreadAfterSeq` 传打开会话时的 lastReadSeq：第一条比它大的消息前插未读分隔线。
 */
export function buildTimeline(input: {
  messages: ImMessage[];
  selfUserId: string | null;
  unreadAfterSeq?: number;
  now: number;
  dayLabels: ImTimeLabels;
}): ImTimelineRow[] {
  const rows: ImTimelineRow[] = [];
  let unreadInserted = false;
  let previous: ImMessage | null = null;

  for (const message of input.messages) {
    if (!previous || !sameDay(previous.createdAt, message.createdAt)) {
      rows.push({
        kind: "day",
        key: `day-${message.id}`,
        label: formatDayDivider(message.createdAt, input.now, input.dayLabels),
      });
      previous = null;
    }
    if (
      !unreadInserted &&
      input.unreadAfterSeq !== undefined &&
      message.seq > input.unreadAfterSeq
    ) {
      rows.push({ kind: "unread", key: `unread-${message.id}`, label: "unread" });
      unreadInserted = true;
    }
    if (message.kind === "system") {
      rows.push({ kind: "system", key: message.id, message });
      // 系统消息前后都不合并：上一条人说的话不能和它拼成一组。
      previous = null;
      continue;
    }
    const mine = input.selfUserId !== null && message.senderId === input.selfUserId;
    const showHeader =
      previous === null ||
      previous.senderId !== message.senderId ||
      message.createdAt - previous.createdAt > GROUP_WINDOW_MS;
    rows.push({
      kind: "message",
      key: message.id,
      message,
      mine,
      showHeader,
      gap: showHeader ? "normal" : "tight",
    });
    previous = message;
  }
  return rows;
}
