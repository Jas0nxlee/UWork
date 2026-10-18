/**
 * IM 面板的视觉常量（一处定义，四个区共用）。
 *
 * 为什么要有这个文件：界面"看起来简陋"从来不是某个组件的问题，而是**每个组件各写一套**——
 * 行高 40/44/56 混用、分隔线有时候有有时候没有、悬停有人用 accent 有人用 surface，
 * 拼在一起就是"不协调"。这里把暗色下的层级、间距、字号定死，组件只引用不发明。
 *
 * 层级（暗色下靠"越靠前越亮"，而不是靠边框和阴影堆出来）：
 *   background（最底，面板底色） < surface（可交互块，白 5%） < surface-hover（悬停，白 10%）
 *   < selected（选中，白 10% + 前景色加强）；浮层（工具条/菜单/对话框）另加 border + shadow。
 *
 * 间距节奏：4 / 8 / 12 / 16，别出现 5、7、14 这种数。
 */

/**
 * 底色两级（用主题自己的 token，不新造颜色）：
 *   chrome（rail / 会话列表 / 右栏）= `bg-sidebar`（#161616）
 *   canvas（消息列）= `bg-background`（#0f0f0f，比 chrome 更深）
 * 这样"导航"和"内容"从底色上就分得开——之前全是同一个 #0f0f0f，只能靠 hairline 硬撑，
 * 看上去就是"没有设计"。
 */
export const IM_PANEL = "bg-background text-foreground";
export const IM_CHROME = "bg-sidebar text-foreground";
export const IM_DIVIDER_X = "border-border";

/** 第一栏（rail）：56px，图标按钮 36px，选中态用"填充 + 左侧指示条"，不用蓝色 accent。 */
export const IM_RAIL =
  "flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-3";
export const IM_RAIL_ITEM =
  "relative flex size-9 items-center justify-center rounded-xl text-foreground-subtle transition-colors hover:bg-surface hover:text-foreground";
export const IM_RAIL_ITEM_ACTIVE = "bg-surface text-foreground";
export const IM_RAIL_INDICATOR =
  "pointer-events-none absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-foreground/30";

/** 区头：48px 统一高度，标题 + 一行次要信息，右侧动作靠 `ml-auto`。 */
export const IM_HEADER = "flex h-12 shrink-0 items-center gap-3 border-b border-border px-4";
export const IM_HEADER_TITLE = "text-ui-sm font-medium text-foreground";
export const IM_HEADER_SUBTITLE = "text-ui-2xs text-foreground-subtle";

/** 列区内边距：列表与右栏用 px-3，消息列用 px-4（正文要更宽的呼吸感）。 */
export const IM_LIST_PADDING = "px-3";
export const IM_MESSAGE_PADDING = "px-4";

/** 搜索框：一个灰面块，不描边（描边的搜索框在暗色下像输入错误的表单）。 */
export const IM_SEARCH_INPUT =
  "h-8 w-full rounded-lg border-0 bg-surface px-2.5 text-ui-xs text-foreground placeholder:text-foreground-subtle focus-visible:ring-1 focus-visible:ring-border-hover";

/** 会话行：56px 高，悬停/选中用灰面（选中比悬停再亮一档），未读用主色但只占一个小点或胶囊。 */
export const IM_LIST_ROW =
  "group/row relative flex h-14 w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors";
/** 选中行左侧那条 2px 强调条：只靠底色差，暗色下几乎看不出来。 */
export const IM_LIST_ROW_MARKER =
  "pointer-events-none absolute top-1/2 left-0 h-6 w-0.5 -translate-y-1/2 rounded-full bg-foreground/40";
export const IM_LIST_ROW_IDLE = "hover:bg-surface";
export const IM_LIST_ROW_ACTIVE = "bg-selected";
export const IM_LIST_NAME = "truncate text-ui-sm font-medium text-foreground";
export const IM_LIST_PREVIEW = "truncate text-ui-2xs text-foreground-subtle";
export const IM_LIST_TIME = "shrink-0 text-ui-2xs text-foreground-subtle tabular-nums";
export const IM_LIST_GROUP_LABEL =
  "px-2.5 pt-3 pb-1 text-[11px] font-medium tracking-wide text-foreground-subtle";
export const IM_UNREAD_PILL =
  "min-w-4 shrink-0 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground";
export const IM_UNREAD_DOT = "size-2 shrink-0 rounded-full bg-primary/70";

/** 头像：列表 40、消息 36、右栏 32、区头 32——四种尺寸对应四种信息层级，不要临时改。 */
export const IM_AVATAR_LIST =
  "flex size-10 shrink-0 items-center justify-center text-ui-xs font-medium";
export const IM_AVATAR_MESSAGE =
  "flex size-9 shrink-0 items-center justify-center text-ui-2xs font-medium";

/** 消息列内容宽度：面板可能被拖到 1000px+，正文要按阅读宽度收住（Slack 也这么做）。 */
export const IM_CONTENT_WIDTH = "mx-auto flex w-full max-w-3xl flex-col";

/** 消息列：名字 13px、时刻 11px、正文 14/22；同组消息贴紧，跨组留 12px。 */
export const IM_MESSAGE_ROW = "group/message relative flex gap-3 rounded-lg px-2 py-0.5";
export const IM_MESSAGE_NAME = "text-ui-sm font-medium text-foreground";
export const IM_MESSAGE_TIME = "text-ui-2xs text-foreground-subtle tabular-nums";
export const IM_MESSAGE_BODY =
  "mt-0.5 text-ui-base leading-[22px] whitespace-pre-wrap break-words text-foreground";
export const IM_MESSAGE_GROUP_GAP = "mt-3";
export const IM_MESSAGE_TIGHT_GAP = "mt-0.5";

/** 分隔行（日期 / 未读 / 系统消息）：一条 hairline + 中间小字，或一个灰面胶囊。 */
export const IM_DIVIDER_ROW = "my-3 flex items-center gap-2 px-1";
export const IM_DIVIDER_LINE = "h-px flex-1 bg-border";
export const IM_DIVIDER_LABEL = "text-ui-2xs text-foreground-subtle";
export const IM_SYSTEM_PILL =
  "rounded-full bg-surface px-2.5 py-1 text-ui-2xs text-foreground-subtle";

/** 悬停工具条：浮层，必须带 border + shadow，否则贴在正文上会糊成一片。 */
export const IM_TOOLBAR =
  "pointer-events-none absolute -top-3 right-1 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 shadow-lg transition-opacity";
export const IM_TOOLBAR_BUTTON =
  "rounded-md px-1.5 py-1 text-ui-2xs text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground";
export const IM_TOOLBAR_BUTTON_DANGER = "text-primary hover:text-primary";

/** 输入区：外层留白 + 内层灰面块；聚焦只换描边，不换底色。 */
export const IM_COMPOSER_WRAP = "shrink-0 border-t border-border px-4 pt-3 pb-4";
export const IM_COMPOSER_BOX =
  "flex items-end gap-2 rounded-xl border border-border bg-surface px-3 py-2 transition-colors focus-within:border-border-hover";
export const IM_COMPOSER_INPUT =
  "max-h-32 min-h-6 flex-1 resize-none border-0 bg-transparent p-0 text-ui-base text-foreground shadow-none placeholder:text-foreground-subtle focus-visible:ring-0";
export const IM_HINT = "text-ui-2xs text-foreground-subtle";

/** 空态：图标 + 一句话，居中但不贴顶（贴顶会显得像加载失败）。 */
export const IM_EMPTY = "flex h-full flex-col items-center justify-center gap-2 px-6 text-center";
export const IM_EMPTY_ICON = "size-6 text-foreground-subtle/60";
export const IM_EMPTY_TEXT = "text-ui-xs text-foreground-subtle";
