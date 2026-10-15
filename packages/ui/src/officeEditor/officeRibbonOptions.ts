/**
 * 功能区的选项常量（调色板 / 字体字号 / 标题级别 / 行距 / 页面参数 / 样式库）。
 *
 * 拆出来是为了守住仓库的 400 行上限；语义与出处见 officeRibbonModel.ts 顶部注释：
 * 行距是**倍数**（官方 demo 的 data-rowmargin），底纹**只用浅色**（深色底纹会吞掉黑字，真机反馈）。
 */
import type { CSSProperties } from "react";
import type { RibbonGallery } from "./officeRibbonModel.js";

/** 文字颜色：深色为主，另含浅色（用于深色底纹场景）。 */
export const TEXT_COLORS = [
  "rgb(0, 0, 0)",
  "rgb(38, 38, 38)",
  "rgb(115, 115, 115)",
  "rgb(217, 38, 38)",
  "rgb(230, 126, 34)",
  "rgb(241, 196, 15)",
  "rgb(46, 139, 87)",
  "rgb(41, 128, 185)",
  "rgb(52, 73, 94)",
  "rgb(142, 68, 173)",
  "rgb(255, 255, 255)",
  "rgb(255, 221, 221)",
  "rgb(255, 236, 179)",
  "rgb(211, 247, 211)",
  "rgb(204, 229, 255)",
  "rgb(233, 222, 255)",
];

/**
 * 高亮（底纹）：**只用浅色**——Word 的底纹调色板同理。
 * 之前把深色也放进来，选到深色底纹后黑字被吞掉，看起来就像"文字消失了"（真机反馈）。
 */
export const HIGHLIGHT_COLORS = [
  "rgb(255, 255, 0)",
  "rgb(255, 236, 179)",
  "rgb(255, 221, 221)",
  "rgb(211, 247, 211)",
  "rgb(204, 229, 255)",
  "rgb(233, 222, 255)",
  "rgb(214, 245, 255)",
  "rgb(240, 240, 240)",
];

export const FONTS = ["宋体", "仿宋", "黑体", "微软雅黑", "楷体", "等线", "Times New Roman", "Arial", "Calibri"];
export const SIZES = [9, 10.5, 11, 12, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 42, 48, 56, 72];

/** 样式库（对标 Word/WPS 的「正文 / 标题 1..」）：预览按实际字号字重渲染。 */
export const STYLE_GALLERY: RibbonGallery = {
  kind: "gallery",
  label: "样式",
  title: "样式库",
  items: [
    { label: "正文", args: [null], style: { fontSize: 13, fontWeight: 400 } },
    { label: "标题 1", args: ["h1"], style: { fontSize: 19, fontWeight: 700 } },
    { label: "标题 2", args: ["h2"], style: { fontSize: 17, fontWeight: 600 } },
    { label: "标题 3", args: ["h3"], style: { fontSize: 15, fontWeight: 600 } },
    { label: "标题 4", args: ["h4"], style: { fontSize: 14, fontWeight: 600, fontStyle: "italic" } },
    { label: "标题 5", args: ["h5"], style: { fontSize: 13, fontWeight: 500, fontStyle: "italic" } },
  ],
  current: (style) => (style.level ? `标题 ${String(style.level).replace("h", "")}` : "正文"),
};
