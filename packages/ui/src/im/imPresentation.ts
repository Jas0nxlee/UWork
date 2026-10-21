import { describeSystemMessage } from "./imSystemMessage.js";
import {
  parseImAttachmentBody,
  parseImCard,
  type ImDirectoryUser,
  type ImConversationSummary,
  type ImMessage,
} from "@zcode/shared";

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

/**
 * 通讯录按部门分栏。
 *
 * 三条口径（都来自真机上"看起来对不对"的判断）：
 * 1. **归到主部门**（`departments[0]`，服务端已切好 token，客户端不再自己切）——一个人挂两个部门时
 *    只出现在第一栏：同一张脸在列表里出现两次比"漏一个部门"更迷惑（搜索仍按任意部门匹配）；
 * 2. 组内按姓名排（在同一部门里找人靠"扫一遍"），组间按部门名排，**未分组永远在最后**；
 * 3. 空分组不渲染；一个人也照样显示栏头——否则会以为这人没有部门。
 */
export interface ImDirectoryGroup {
  key: string;
  title: string;
  members: ImDirectoryUser[];
}

export function groupDirectoryByDepartment(
  users: readonly ImDirectoryUser[],
  unknownLabel: string,
): ImDirectoryGroup[] {
  const byDepartment = new Map<string, ImDirectoryUser[]>();
  for (const user of users) {
    const primary = user.departments[0] ?? "";
    const bucket = byDepartment.get(primary) ?? [];
    bucket.push(user);
    byDepartment.set(primary, bucket);
  }
  const collator = new Intl.Collator("zh-Hans-CN");
  return [...byDepartment.entries()]
    .map(([department, members]) => ({
      key: department || "__none__",
      title: department || unknownLabel,
      members: [...members].sort((a, b) => collator.compare(a.name ?? a.id, b.name ?? b.id)),
    }))
    .sort((a, b) => {
      if (a.key === "__none__") return 1;
      if (b.key === "__none__") return -1;
      return collator.compare(a.title, b.title);
    });
}

/**
 * 面板宽度三档——决定"列表是停靠、还是折叠成浮层"。
 *
 * 阈值是**按内容需求算出来的，不是拍的**：三栏要舒适，需要
 *   rail 56 + 列表 240 + 消息列 ≥ 560 ≈ 856
 * 所以 <720 就把列表折叠成浮层（三栏到这个宽度已经开始互相挤），720–879 停靠但列表收窄，
 * ≥880 才是舒适三栏。**判定跟随面板实际宽度**（用户拖的是面板，不是窗口），切档自动发生、不用再点一下。
 */
export type ImPaneBand = "narrow" | "medium" | "wide";

export function imPaneBand(width: number): ImPaneBand {
  if (width <= 0) return "medium"; // 还没量到宽度：按停靠渲染，避免首帧闪一下浮层
  if (width < 720) return "narrow";
  return width < 880 ? "medium" : "wide";
}

/**
 * 列表列在某一档 + 某个视图下的形态。
 *
 * 抽出来的理由：这三种状态（停靠 / 浮层 / 不显示）散在 JSX 的 className 里就只能靠肉眼验，
 * 而它恰恰是"面板能拖到 240px"这条约束下最容易出错的地方——拖窄了消息列被挤没、或浮层收不回去。
 */
export interface ImListColumnState {
  /** docked：占一栏；overlay：盖在消息列上；hidden：不显示（浮层未打开，或当前是别的视图）。 */
  mode: "docked" | "overlay" | "hidden";
  /** 宽度类（按档取：宽档舒适、其余窄一点）。 */
  widthClass: "w-60" | "w-52" | "w-64";
  /** 窄档浮层打开时要渲一层背板（点击关闭）。 */
  backdrop: boolean;
}

export function imListColumnState(input: {
  band: ImPaneBand;
  listOverlayOpen: boolean;
  railView: "messages" | "directory" | "bookmarks" | "reports";
}): ImListColumnState {
  if (input.band === "narrow") {
    // 窄档：列表不是一栏。只有"消息"视图 + 用户主动打开时才作为浮层出现
    const open = input.listOverlayOpen && input.railView === "messages";
    return { mode: open ? "overlay" : "hidden", widthClass: "w-64", backdrop: open };
  }
  // 中/宽档：只有"消息"视图停靠列表；通讯录/汇报/收藏各自占满列表位
  const docked = input.railView === "messages";
  return {
    mode: docked ? "docked" : "hidden",
    widthClass: input.band === "wide" ? "w-60" : "w-52",
    backdrop: false,
  };
}

/**
 * **把卡片动作翻译成一个可执行的分派**（纯函数，见 specs/messaging-and-channels.md §12.18）。
 *
 * 为什么要单独一步而不是在 onAction 里 if 一片：分派规则是"卡片动作 → 业务动作"的**唯一映射**，
 * 写散在 JSX 里就只能靠点着试；抽出来之后可以单测穷举"未知类型/未知动作/缺 target"这些**必须不动手**的情况。
 * 不认识的组合一律返回 `unsupported`——渲染器会把按钮置灰而不是静默失败。
 */
export type ImCardActionDispatch =
  | { kind: "work-item"; itemId: string; action: "open" | "review" | "return" }
  | { kind: "unsupported" };

/**
 * **这张卡在"我"眼里是什么身份**（渲染按角色分视角，见 specs/messaging-and-channels.md §12.18）。
 *
 * 纯函数、可穷举单测；判定只用**卡片自己声明的** `audience`（谁发的、给谁的），
 * 不去推理"这个人是什么角色"——推理那件事属于服务端，客户端只负责别把点不动的按钮摆给人看。
 * 老卡片没有 `audience` → `unknown`，界面保持原样（按钮照常显示，由服务端拒绝）。
 */
export type ImCardViewerRole = "addressee" | "author" | "observer" | "unknown";

export function imCardViewerRole(
  document: { audience?: { from?: string; to?: string } },
  selfUserId: string | null | undefined,
): ImCardViewerRole {
  const audience = document.audience;
  if (!audience || (!audience.to && !audience.from)) return "unknown";
  if (!selfUserId) return "observer";
  if (audience.to === selfUserId) return "addressee";
  if (audience.from === selfUserId) return "author";
  return "observer";
}

export function resolveImCardAction(
  action: { id: string; kind: "client" | "server"; target?: string },
  document?: { actions?: { target?: string }[] },
): ImCardActionDispatch {
  // 动作自己的 target 优先；**缺失时用同一张卡片里其它动作的 target 兜底**。
  // 为什么需要兜底（真机踩到，用户手点报"这个动作暂不支持"）：`server` 动作带 target 是后来才加的，
  // 之前投出去的卡片里 `review/return` 没有 target，而卡片描述的就是同一条记录——
  // 靠 `open` 的 target 就能认出对象。按"只认自己的 target"会把存量卡片全判成不可执行。
  const target = action.target ?? document?.actions?.find((item) => item.target)?.target ?? "";
  const [type, id] = target.split(":");
  if (type !== "work-items.item" || !id) return { kind: "unsupported" };
  if (action.id === "open" && action.kind === "client")
    return { kind: "work-item", itemId: id, action: "open" };
  if (action.kind === "server" && (action.id === "review" || action.id === "return"))
    return { kind: "work-item", itemId: id, action: action.id };
  return { kind: "unsupported" };
}

/**
 * **把一条消息的"正文"变成人话**——所有"要把消息内容展示给人看"的地方都必须走这里。
 *
 * 为什么要收成一个口子：body 有四种形态（纯文本 / 系统消息 JSON / 卡片文档 JSON / 附件载荷 JSON），
 * 而"展示"的地方有**六处**（会话列表预览、收藏列表、置顶面板、检索命中、引用块、转发预览、复制）。
 * 之前只修了会话预览与系统通知，结果收藏、引用、转发预览里照样冒出 `{"card":…}`——
 * 同一类 bug 修了两处、漏了五处。**新增加载荷只要在这里加一个分支，六处就全都跟着对。**
 */
export function messageBodyText(
  message: Pick<ImMessage, "kind" | "body" | "deletedAt" | "senderId">,
  t: (id: string, values?: Record<string, string | number>) => string,
  nameOf: (id: string) => string | undefined = () => undefined,
): string {
  if (message.deletedAt !== null) return t("im.withdrawn");
  if (message.kind === "system") return describeSystemMessage(message.body, nameOf, t).text;
  if (message.kind === "card") {
    const card = parseImCard(message.body);
    return card?.fallback ?? t("im.previewCard");
  }
  if (message.kind === "attachment") {
    const attachment = parseImAttachmentBody(message.body);
    if (!attachment) return t("im.previewFile");
    const kindLabel = /^image\//i.test(attachment.mime)
      ? t("im.previewImage")
      : t("im.previewFile");
    return `${kindLabel} ${attachment.name}`;
  }
  return message.body;
}
