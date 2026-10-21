/**
 * **通用卡片文档**（`kind === "card"`）。IM 里的卡片是**数据，不是代码**：
 * 加一种卡片 = 加一份文档/模板，不发客户端版本（见 `specs/work-reports-and-rollup.md` §8.7）。
 *
 * 三条硬规矩：
 * 1. **`fallback` 必填**：会话预览、系统通知、全文检索、企微兜底消息，以及"客户端不认识这个
 *    type/version"时，全都退化成这段纯文本——永远不出现空白卡片或读出来一串 JSON。
 * 2. **原语刻意小**：只认下面这几种 section。不认识的 section **跳过**（前向兼容），
 *    不允许任意布局——一旦允许，就等于在消息里写前端。
 * 3. **actions 不含代码**：`client` 交给客户端注册的处理器（如打开详情），
 *    `server` 由服务端校验"这个人能不能做这个动作"后执行。权限判定永远在服务端，
 *    不信卡片自己的声明。
 *
 * 注意：**不许任意 HTML/JS 进 IM 卡片**。仓库里的 Gen UI 沙箱服务的是"本地助手 + 本机文件"
 * 那一侧（同一信任域），消息来自别人，HTML 内容是攻击面（沙箱挡得住脚本，挡不住骗人）。
 */
export type ImCardTone = "default" | "muted" | "danger" | "warning" | "success";

export type ImCardSection =
  | { kind: "text"; label?: string; text: string; tone?: ImCardTone }
  | { kind: "fields"; label?: string; fields: { label: string; value: string }[] }
  | { kind: "list"; label?: string; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "divider" }
  | { kind: "progress"; label?: string; value: number; max?: number };

export interface ImCardAction {
  id: string;
  label: string;
  /** client：客户端处理器；server：服务端校验后执行（权限判定永远在服务端）。 */
  kind: "client" | "server";
  style?: "default" | "primary" | "danger";
  /**
   * 动作的作用对象，形如 `<类型>:<标识>`（如 `work-items.item:<id>`）。
   * - `client`：**去向**（打开哪个界面）；
   * - `server`：**作用对象**（对哪条记录动手），客户端据此分派执行器。
   */
  target?: string;
}

export interface ImCardAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface ImCardDocument {
  card: { version: number; type: string };
  fallback: string;
  title: string;
  subtitle?: string;
  /**
   * **这张卡是给谁的**（`to`）与**谁发的**（`from`）。
   *
   * 为什么必须有：卡片投在作者↔审核人的 DM 里、双方都是会话成员，只声明"谁发的"就会让两边渲染成一个样子
   * （真机踩到：作者看到点不动的「已阅/退回」，审核人看到本该发给作者的回执卡且显示成"自己提交的"）。
   * 客户端据此分视角：收件人＝可操作、发起人＝所有者视角、其他人＝只读（见 §12.18）。
   * **老卡片可能没有这个字段**（`to` 是后加的）——那种情况保持老行为，由服务端判权限。
   */
  audience?: { from?: string; to?: string };
  badges?: { text: string; tone?: ImCardTone }[];
  sections?: ImCardSection[];
  attachments?: ImCardAttachment[];
  actions?: ImCardAction[];
}

const CARD_TONES: ImCardTone[] = ["default", "muted", "danger", "warning", "success"];

function asTone(value: unknown): ImCardTone | undefined {
  return typeof value === "string" && (CARD_TONES as string[]).includes(value)
    ? (value as ImCardTone)
    : undefined;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 只保留渲染器认识的原语；**不认识的 section 直接丢掉**（跳过比崩掉强，也避免渲染未知结构）。 */
function parseSection(value: unknown): ImCardSection | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const tone = asTone(raw.tone);
  if (raw.kind === "text" && typeof raw.text === "string") {
    return {
      kind: "text",
      text: raw.text,
      ...(typeof raw.label === "string" ? { label: raw.label } : {}),
      ...(tone ? { tone } : {}),
    };
  }
  if (raw.kind === "fields" && Array.isArray(raw.fields)) {
    const fields = raw.fields
      .map((field) => field as { label?: unknown; value?: unknown })
      .filter((field) => typeof field?.label === "string" && typeof field?.value === "string")
      .map((field) => ({ label: field.label as string, value: field.value as string }));
    if (fields.length === 0) return null;
    return {
      kind: "fields",
      fields,
      ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    };
  }
  if (raw.kind === "list" && Array.isArray(raw.items)) {
    const items = raw.items.filter((item): item is string => typeof item === "string");
    if (items.length === 0) return null;
    return { kind: "list", items, ...(typeof raw.label === "string" ? { label: raw.label } : {}) };
  }
  if (raw.kind === "quote" && typeof raw.text === "string")
    return { kind: "quote", text: raw.text };
  if (raw.kind === "divider") return { kind: "divider" };
  if (raw.kind === "progress" && typeof raw.value === "number") {
    return {
      kind: "progress",
      value: raw.value,
      ...(typeof raw.max === "number" ? { max: raw.max } : {}),
      ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    };
  }
  return null;
}

/**
 * 解析卡片文档。**缺 `fallback` 或 `card.type` 就判为无效**——宁可退化成文本，
 * 也不要渲染一张没有文案兜底的卡片。
 */
export function parseImCard(body: string): ImCardDocument | null {
  try {
    const raw = JSON.parse(body) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return null;
    const meta = raw.card as { version?: unknown; type?: unknown } | undefined;
    const fallback = asText(raw.fallback).trim();
    const title = asText(raw.title).trim();
    if (!meta || typeof meta.type !== "string" || meta.type.length === 0) return null;
    if (typeof meta.version !== "number") return null;
    if (fallback.length === 0) return null;

    const sections = Array.isArray(raw.sections)
      ? raw.sections
          .map(parseSection)
          .filter((section): section is ImCardSection => section !== null)
      : [];
    const badges = Array.isArray(raw.badges)
      ? raw.badges
          .map((badge) => badge as { text?: unknown; tone?: unknown })
          .filter((badge) => typeof badge?.text === "string")
          .map((badge) => ({
            text: badge.text as string,
            ...(asTone(badge.tone) ? { tone: asTone(badge.tone) as ImCardTone } : {}),
          }))
      : [];
    const attachments = Array.isArray(raw.attachments)
      ? raw.attachments
          .map((item) => item as Partial<ImCardAttachment>)
          .filter((item) => typeof item?.id === "string" && typeof item?.name === "string")
          .map((item) => ({
            id: item.id as string,
            name: item.name as string,
            mime: asText(item.mime),
            size: typeof item.size === "number" ? item.size : 0,
          }))
      : [];
    const actions = Array.isArray(raw.actions)
      ? raw.actions
          .map((item) => item as Partial<ImCardAction>)
          .filter(
            (item) =>
              typeof item?.id === "string" &&
              typeof item?.label === "string" &&
              (item.kind === "client" || item.kind === "server"),
          )
          .map((item) => ({
            id: item.id as string,
            label: item.label as string,
            kind: item.kind as "client" | "server",
            ...(item.style ? { style: item.style } : {}),
            ...(typeof item.target === "string" ? { target: item.target } : {}),
          }))
      : [];

    // `_authorId` 是历史写法里的发起人；`to` 是收件人。两者都缺＝老卡片。
    const audience = {
      ...(typeof raw._authorId === "string" && raw._authorId ? { from: raw._authorId } : {}),
      ...(typeof raw.to === "string" && raw.to ? { to: raw.to } : {}),
    };
    return {
      card: { version: meta.version, type: meta.type },
      fallback,
      title,
      ...(audience.from || audience.to ? { audience } : {}),
      ...(typeof raw.subtitle === "string" ? { subtitle: raw.subtitle } : {}),
      ...(badges.length ? { badges } : {}),
      ...(sections.length ? { sections } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(actions.length ? { actions } : {}),
    };
  } catch {
    return null;
  }
}
