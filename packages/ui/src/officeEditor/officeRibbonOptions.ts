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

/**
 * 字体：给**跨平台字体栈**而不是单一字体名。
 *
 * 真机反馈"字体没有变化"：原来只列 Windows 字体名（宋体/仿宋/黑体/微软雅黑/楷体），
 * 在 macOS 上这些名字全部解析失败 → 统统回退到同一套系统字体，于是"换了跟没换一样"。
 * 引擎把它直接塞进 canvas 的 `font`，所以用 CSS 风格的候选列表即可（逗号分隔、逐个回退）。
 * 显示名仍用用户熟悉的中文名，值用字体栈。
 */
export const FONTS: Array<{ label: string; value: string }> = [
  { label: "宋体", value: "SimSun, Songti SC, STSong, serif" },
  { label: "仿宋", value: "FangSong, STFangsong, serif" },
  { label: "黑体", value: "SimHei, Heiti SC, STHeiti, sans-serif" },
  { label: "微软雅黑", value: "Microsoft YaHei, PingFang SC, Hiragino Sans GB, sans-serif" },
  { label: "楷体", value: "KaiTi, Kaiti SC, STKaiti, serif" },
  { label: "等线", value: "DengXian, PingFang SC, sans-serif" },
  { label: "苹方", value: "PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif" },
  { label: "Times New Roman", value: "Times New Roman, Times, serif" },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Calibri", value: "Calibri, Carlito, Arial, sans-serif" },
];

export const SIZES = [9, 10.5, 11, 12, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 42, 48, 56, 72];

/**
 * 样式库（对标 Word/WPS 的「正文 / 标题 1..」）：预览按实际字号字重渲染。
 *
 * ⚠️ 参数是引擎的 `TitleLevel` 枚举：**first/second/…/sixth**，不是 `h1`/`h2`。
 * 我一开始传 `h1`，引擎查不到对应级别就**静默什么都不做**（真机反馈"标题没有正常生效"），
 * 值取自引擎 dist（`TitleLevel.FIRST = "first" … SIXTH = "sixth"`）与官方 demo 的 data-level。
 */
export const STYLE_GALLERY: RibbonGallery = {
  kind: "gallery",
  label: "样式",
  title: "样式库",
  items: [
    { label: "正文", args: [null], style: { fontSize: 13, fontWeight: 400 } },
    { label: "标题 1", args: ["first"], style: { fontSize: 19, fontWeight: 700 } },
    { label: "标题 2", args: ["second"], style: { fontSize: 17, fontWeight: 600 } },
    { label: "标题 3", args: ["third"], style: { fontSize: 15, fontWeight: 600 } },
    { label: "标题 4", args: ["fourth"], style: { fontSize: 14, fontWeight: 600, fontStyle: "italic" } },
    { label: "标题 5", args: ["fifth"], style: { fontSize: 13, fontWeight: 500, fontStyle: "italic" } },
  ],
  current: (style) => {
    const order = ["first", "second", "third", "fourth", "fifth", "sixth"];
    const index = order.indexOf(String(style.level ?? ""));
    return index >= 0 ? `标题 ${index + 1}` : "正文";
  },
};
