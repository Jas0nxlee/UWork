/**
 * 卡片的视觉系统（通用卡片共用，与具体卡片类型无关）。
 *
 * 为什么单独一份：卡片是数据驱动的，**渲染器只有一次机会把任何卡片都排好看**——
 * 结构（头部/分区/动作条）与色板（tone → 颜色）必须固定下来，否则每来一种卡片就会长出一个新样子。
 * 参照成熟 IM（飞书/企微/Slack）：类型图标 + 标题 + 元信息行 → 分隔线 → 分区内容 → 底部动作条。
 */
import type { ImCardTone } from "@zcode/shared";

/** 卡片外壳：容器 + 左侧强调条（强调条按 tone 上色，是"这是什么卡"的第一眼信号）。 */
export const CARD_SHELL =
  "mt-1.5 w-full max-w-[32rem] overflow-hidden rounded-xl border border-border bg-surface/40";

/** 左侧强调条：2px 竖线，颜色跟着 tone 走。 */
export const CARD_ACCENT: Record<ImCardTone, string> = {
  default: "bg-border-hover",
  muted: "bg-border",
  danger: "bg-destructive",
  warning: "bg-amber-500/70",
  success: "bg-emerald-500/70",
};

/** 头部：图标 + 标题 + 徽标。 */
export const CARD_HEADER = "flex items-start gap-2.5 px-3.5 pt-3";
export const CARD_ICON_BOX =
  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-background/80";
export const CARD_TITLE = "min-w-0 flex-1 text-ui-sm font-medium leading-5 text-foreground";
export const CARD_META = "px-3.5 pt-0.5 text-ui-2xs text-foreground-subtle";
export const CARD_BADGE: Record<ImCardTone, string> = {
  default: "bg-background/80 text-foreground-subtle",
  muted: "bg-background/80 text-foreground-subtle",
  warning: "bg-amber-500/15 text-amber-500",
  danger: "bg-destructive/15 text-destructive",
  success: "bg-emerald-500/15 text-emerald-500",
};
export const CARD_BADGE_BASE =
  "shrink-0 rounded-full px-2 py-0.5 text-ui-2xs font-medium leading-4";

/** 分区：组间 12px，标签与内容 4px（label 与 value 要成对，不能混成流水账）。 */
export const CARD_BODY = "flex flex-col gap-3 px-3.5 pt-3";
export const CARD_LABEL = "text-ui-2xs font-medium text-foreground-subtle";
export const CARD_TEXT = "mt-1 whitespace-pre-wrap text-ui-sm leading-5 text-foreground";
export const CARD_TEXT_TONE: Record<ImCardTone, string> = {
  default: "text-foreground",
  muted: "text-foreground-subtle",
  danger: "text-foreground",
  warning: "text-foreground",
  success: "text-foreground",
};

/** 风险/问题块：底色 + 左描边 + 图标——不能只把字染红，染红看起来像报错。 */
export const CARD_ALERT =
  "mt-1 flex items-start gap-2 rounded-lg border-l-2 border-destructive bg-destructive/8 px-2.5 py-2";

/** 附件：一行一个，图标 + 名字 + 大小；不塞成一片小芯片（芯片里长文件名读不出来）。 */
export const CARD_ATTACHMENT_ROW =
  "mt-1 flex items-center gap-2 rounded-lg bg-background/60 px-2.5 py-1.5";

/** 底部动作条：与内容用分隔线断开，动作右对齐、有主次。 */
export const CARD_FOOTER =
  "mt-3 flex items-center justify-end gap-2 border-t border-border/70 px-3.5 py-2.5";
export const CARD_ACTION_PRIMARY =
  "rounded-lg bg-primary/90 px-2.5 py-1 text-ui-2xs font-medium text-primary-foreground transition-colors hover:bg-primary";
export const CARD_ACTION_SECONDARY =
  "rounded-lg border border-border bg-background/60 px-2.5 py-1 text-ui-2xs font-medium text-foreground transition-colors hover:border-border-hover hover:bg-surface";
