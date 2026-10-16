/**
 * 编辑功能区的数据模型：类型定义与构造器（`button` / `colorSelect`）。
 * 各标签页的实际数据在 officeRibbonTabs.ts——拆开只为守住仓库的 400 行上限。
 *
 * 命令名与参数形态**照抄 canvas-editor 官方 demo**（Hufe921/canvas-editor 的 src/main.ts，
 * 2477 行 vanilla TS 实现的 Word 级工具栏）；官方仓库还按菜单逐个写了 e2e
 * （text/format/title/list/row/table/image/hyperlink/date/checkbox/codeblock/latex/pagebreak/
 *  watermark/painter/search/print/pageLayout）——这就是我们功能面的依据。
 *
 * 图标用微软自家的 **@fluentui/react-icons（MIT）**；名字是"基名+尺寸+字重"（如 TextBold24Regular），
 * 下面每个 icon 都是在安装包里核对过的真实导出名。
 *
 * 引擎没有的能力不假装：canvas-editor **没有缩进（首行/悬挂缩进）命令**，
 * 所以对标 WPS 时那一排缩进按钮我们没有做（用列表层级与行距代之）。
 */
import type { CSSProperties } from "react";
export interface RibbonStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeout?: boolean;
  painter?: boolean;
  undo?: boolean;
  redo?: boolean;
  rowFlex?: string | null;
  level?: string | null;
  listType?: string | null;
  font?: string;
  size?: number;
  color?: string | null;
  highlight?: string | null;
}

export interface RibbonCommand {
  kind: "command";
  label: string;
  title: string;
  command: string;
  args?: unknown[];
  icon?: string;
  /** 需要一句话参数的命令（图片/超链接/LaTeX/水印）：取到后填进 args 的 index。 */
  prompt?: { message: string; at: number };
}

export interface RibbonSelect {
  kind: "select";
  label: string;
  title: string;
  options: Array<{ label: string; args: unknown[] }>;
  current?: (style: RibbonStyle) => string | null;
  icon?: string;
  /** 颜色类下拉：用当前值画色条（Word/WPS 的分体按钮观感）。 */
  swatch?: (style: RibbonStyle) => string | null;
}

/**
 * 命令菜单：一组相关命令收在一个「A ▾」按钮里（Word 的字体组就是这么放删除线/上下标的）。
 * 侧栏只有几百像素宽时，这一招能省下几十像素，同时不牺牲命令本身。
 */
export interface RibbonMenu {
  kind: "menu";
  label: string;
  title: string;
  icon?: string;
  items: RibbonCommand[];
}

export interface RibbonGallery {
  kind: "gallery";
  label: string;
  title: string;
  items: Array<{ label: string; args: unknown[]; style: CSSProperties }>;
  current?: (style: RibbonStyle) => string | null;
}

export type RibbonItem = RibbonCommand | RibbonSelect | RibbonGallery | RibbonMenu;

export interface RibbonGroup {
  label: string;
  items: RibbonItem[];
  /**
   * 放不下时的取舍顺序：先收「非必要」分组（从左到右），再收必要分组（从右到左）。
   * 这样开始标签在最窄时留下的是字体/段落这两组最常用的，"历史"和"样式"先进 » 菜单。
   */
  essential?: boolean;
}

export interface RibbonTab {
  id: string;
  label: string;
  groups: RibbonGroup[];
  /** 只在表格内可用（光标进表格时出现）。 */
  contextual?: boolean;
}

export const button = (
  label: string,
  title: string,
  command: string,
  options: {
    args?: unknown[];
    icon?: string;
    prompt?: RibbonCommand["prompt"];
  } = {},
): RibbonCommand => ({
  kind: "command",
  label,
  title,
  command,
  ...(options.args ? { args: options.args } : {}),
  ...(options.icon ? { icon: options.icon } : {}),
  ...(options.prompt ? { prompt: options.prompt } : {}),
});

export const colorSelect = (
  label: string,
  title: string,
  icon: string,
  swatchKey: "color" | "highlight",
  palette: readonly string[],
): RibbonSelect => ({
  kind: "select",
  label,
  title,
  icon,
  swatch: (style) => (swatchKey === "color" ? (style.color ?? null) : (style.highlight ?? null)),
  options: [
    { label: swatchKey === "color" ? "自动" : "无底纹", args: [null] },
    ...palette.map((color) => ({ label: color, args: [color] })),
  ],
});
