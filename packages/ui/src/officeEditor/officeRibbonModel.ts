/**
 * 编辑功能区的数据模型：分组 / 按钮 / 下拉 / 样式库。
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

export interface RibbonGallery {
  kind: "gallery";
  label: string;
  title: string;
  items: Array<{ label: string; args: unknown[]; style: CSSProperties }>;
  current?: (style: RibbonStyle) => string | null;
}

export type RibbonItem = RibbonCommand | RibbonSelect | RibbonGallery;

export interface RibbonGroup {
  label: string;
  items: RibbonItem[];
}

export interface RibbonTab {
  id: string;
  label: string;
  groups: RibbonGroup[];
  /** 只在表格内可用（光标进表格时出现）。 */
  contextual?: boolean;
}

const COLORS = [
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

const FONTS = ["宋体", "仿宋", "黑体", "微软雅黑", "楷体", "等线", "Times New Roman", "Arial", "Calibri"];
const SIZES = [9, 10.5, 11, 12, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 42, 48, 56, 72];

/** 样式库（对标 Word/WPS 的「正文 / 标题 1..」）：预览按实际字号字重渲染。 */
const STYLE_GALLERY: RibbonGallery = {
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

const button = (
  label: string,
  title: string,
  command: string,
  options: { args?: unknown[]; icon?: string; prompt?: RibbonCommand["prompt"] } = {},
): RibbonCommand => ({
  kind: "command",
  label,
  title,
  command,
  ...(options.args ? { args: options.args } : {}),
  ...(options.icon ? { icon: options.icon } : {}),
  ...(options.prompt ? { prompt: options.prompt } : {}),
});

const colorSelect = (
  label: string,
  title: string,
  icon: string,
  swatchKey: "color" | "highlight",
): RibbonSelect => ({
  kind: "select",
  label,
  title,
  icon,
  options: [{ label: "自动", args: [null] }, ...COLORS.map((color) => ({ label: color, args: [color] }))],
  swatch: (style) => (swatchKey === "color" ? (style.color ?? null) : (style.highlight ?? null)),
});

export const RIBBON_TABS: RibbonTab[] = [
  {
    id: "home",
    label: "开始",
    groups: [
      {
        label: "历史",
        items: [
          button("撤销", "撤销 (⌘Z)", "executeUndo", { icon: "ArrowUndo24Regular" }),
          button("重做", "重做 (⇧⌘Z)", "executeRedo", { icon: "ArrowRedo24Regular" }),
          button("格式刷", "格式刷：先选带格式的文字，再点要套用的文字", "executePainter", {
            icon: "PaintBrush24Regular",
          }),
          button("清除格式", "清除格式", "executeFormat", { icon: "ClearFormatting24Regular" }),
        ],
      },
      {
        label: "字体",
        items: [
          {
            kind: "select",
            label: "字体",
            title: "字体",
            options: FONTS.map((font) => ({ label: font, args: [font] })),
            current: (style) => style.font ?? null,
          },
          {
            kind: "select",
            label: "字号",
            title: "字号",
            options: SIZES.map((size) => ({ label: String(size), args: [size] })),
            current: (style) => (style.size ? String(style.size) : null),
          },
          button("增大字号", "增大字号", "executeSizeAdd", { icon: "FontIncrease24Regular" }),
          button("减小字号", "减小字号", "executeSizeMinus", { icon: "FontDecrease24Regular" }),
          button("加粗", "加粗 (⌘B)", "executeBold", { icon: "TextBold24Regular" }),
          button("斜体", "斜体 (⌘I)", "executeItalic", { icon: "TextItalic24Regular" }),
          button("下划线", "下划线 (⌘U)", "executeUnderline", { icon: "TextUnderline24Regular" }),
          button("删除线", "删除线", "executeStrikeout", { icon: "TextStrikethrough24Regular" }),
          button("上标", "上标", "executeSuperscript", { icon: "TextSuperscript24Regular" }),
          button("下标", "下标", "executeSubscript", { icon: "TextSubscript24Regular" }),
          colorSelect("字色", "文字颜色", "TextColor24Regular", "color"),
          colorSelect("底纹", "高亮（底纹）", "Highlight24Regular", "highlight"),
        ],
      },
      {
        label: "段落",
        items: [
          button("左对齐", "左对齐 (⌘L)", "executeRowFlex", { args: ["left"], icon: "AlignLeft24Regular" }),
          button("居中", "居中 (⌘E)", "executeRowFlex", { args: ["center"], icon: "TextAlignCenter24Regular" }),
          button("右对齐", "右对齐 (⌘R)", "executeRowFlex", { args: ["right"], icon: "AlignRight24Regular" }),
          button("两端对齐", "两端对齐 (⌘J)", "executeRowFlex", {
            args: ["alignment"],
            icon: "TextAlignJustify24Regular",
          }),
          {
            kind: "select",
            label: "行距",
            title: "行距",
            icon: "TextLineSpacing24Regular",
            options: [1, 1.15, 1.5, 2, 2.5, 3].map((ratio) => ({
              label: `${ratio} 倍行距`,
              args: [Math.round(ratio * 24)],
            })),
          },
          button("无序列表", "项目符号", "executeList", { args: ["ul"], icon: "TextBulletListLtr24Regular" }),
          button("有序列表", "编号", "executeList", { args: ["ol"], icon: "TextNumberListLtr24Regular" }),
          button("任务列表", "任务列表", "executeList", { args: ["task"], icon: "TaskListSquareLtr24Regular" }),
        ],
      },
      { label: "样式", items: [STYLE_GALLERY] },
    ],
  },
  {
    id: "insert",
    label: "插入",
    groups: [
      {
        label: "表格",
        items: [
          button("3×3 表格", "插入 3×3 表格", "executeInsertTable", {
            args: [3, 3],
            icon: "TableSimple24Regular",
          }),
          button("5×4 表格", "插入 5×4 表格", "executeInsertTable", { args: [5, 4] }),
        ],
      },
      {
        label: "插图与链接",
        items: [
          button("图片", "插入图片（图片地址）", "executeImage", {
            icon: "Image24Regular",
            prompt: { message: "图片地址（http/https 或 data:）", at: 0 },
          }),
          button("超链接", "插入/编辑超链接", "executeHyperlink", {
            icon: "Link24Regular",
            prompt: { message: "链接地址", at: 0 },
          }),
          button("公式", "插入 LaTeX 公式", "executeLatex", {
            icon: "MathFormula24Regular",
            prompt: { message: "LaTeX 公式（如 E=mc^2）", at: 0 },
          }),
        ],
      },
      {
        label: "控件与块",
        items: [
          {
            kind: "select",
            label: "插入控件",
            title: "插入内容控件（文本/列举/复选/单选/日期/数字）",
            options: [
              { label: "文本控件", args: ["text"] },
              { label: "列举控件", args: ["select"] },
              { label: "复选框控件", args: ["checkbox"] },
              { label: "单选框控件", args: ["radio"] },
              { label: "日期控件", args: ["date"] },
              { label: "数字控件", args: ["number"] },
            ],
          },
          button("日期", "插入当前日期", "executeInsertElementList", {
            args: [{ type: "date", value: "", dateFormat: "yyyy-MM-dd" }],
            icon: "CalendarLtr24Regular",
          }),
          button("复选框", "插入复选框", "executeInsertElementList", {
            args: [{ type: "checkbox", value: false, checkbox: { value: false } }],
            icon: "CheckboxChecked24Regular",
          }),
          button("代码块", "插入代码块", "executeInsertElementList", {
            args: [{ type: "codeblock", value: "", codeBlock: { language: "javascript" } }],
            icon: "Code24Regular",
          }),
          button("引用块", "插入引用块", "executeInsertElementList", {
            args: [{ type: "blockquote", value: "", blockquote: { showLine: true } }],
            icon: "TextQuote24Regular",
          }),
        ],
      },
      {
        label: "页面元素",
        items: [
          button("分隔线", "插入分隔线", "executeSeparator", { icon: "DividerShort24Regular" }),
          button("分页符", "插入分页符", "executePageBreak", { icon: "DocumentPageBreak24Regular" }),
          button("水印", "添加水印", "executeAddWatermark", {
            icon: "DocumentPageBottomCenter24Regular",
            prompt: { message: "水印文字", at: 0 },
          }),
          button("去水印", "删除水印", "executeDeleteWatermark"),
          button("分栏", "分栏（两栏）", "executeSetColumns", {
            args: [{ count: 2, gap: 30, separator: false }],
            icon: "ColumnTriple24Regular",
          }),
        ],
      },
    ],
  },
  {
    id: "table",
    label: "表格工具",
    contextual: true,
    groups: [
      {
        label: "行列",
        items: [
          button("上方插行", "在上方插入行", "executeInsertTableTopRow", { icon: "TableInsertRow24Regular" }),
          button("下方插行", "在下方插入行", "executeInsertTableBottomRow"),
          button("左侧插列", "在左侧插入列", "executeInsertTableLeftCol", { icon: "TableInsertColumn24Regular" }),
          button("右侧插列", "在右侧插入列", "executeInsertTableRightCol"),
          button("删行", "删除当前行", "executeDeleteTableRow", { icon: "TableDeleteRow24Regular" }),
          button("删列", "删除当前列", "executeDeleteTableCol"),
          button("删表", "删除整个表格", "executeDeleteTable", { icon: "Delete24Regular" }),
        ],
      },
      {
        label: "单元格",
        items: [
          button("合并", "合并单元格", "executeMergeTableCell"),
          button("横拆", "水平拆分", "executeSplitHorizontalTableCell"),
          button("竖拆", "垂直拆分", "executeSplitVerticalTableCell"),
          button("全选表", "选中整个表格", "executeTableSelectAll"),
          colorSelect("底色", "单元格底色", "Highlight24Regular", "highlight"),
          {
            kind: "select",
            label: "垂直对齐",
            title: "单元格垂直对齐",
            options: [
              { label: "顶端", args: ["top"] },
              { label: "居中", args: ["middle"] },
              { label: "底端", args: ["bottom"] },
            ],
          },
        ],
      },
      {
        label: "自适应",
        items: [
          button("适应内容", "表格宽度适应内容", "executeTableAutoFitToContent"),
          button("适应页面", "表格宽度适应页面", "executeTableAutoFitToPage"),
        ],
      },
    ],
  },
  {
    id: "layout",
    label: "页面布局",
    groups: [
      {
        label: "页面设置",
        items: [
          {
            kind: "select",
            label: "纸张",
            title: "纸张大小",
            icon: "DocumentFit24Regular",
            options: [
              { label: "A4", args: ["A4"] },
              { label: "A3", args: ["A3"] },
              { label: "A5", args: ["A5"] },
              { label: "B5", args: ["B5"] },
            ],
          },
          {
            kind: "select",
            label: "方向",
            title: "纸张方向",
            options: [
              { label: "纵向", args: ["vertical"] },
              { label: "横向", args: ["horizontal"] },
            ],
          },
          {
            kind: "select",
            label: "页边距",
            title: "页边距",
            options: [
              { label: "常规", args: [[100, 120, 100, 120]] },
              { label: "窄", args: [[60, 60, 60, 60]] },
              { label: "宽", args: [[160, 200, 160, 200]] },
            ],
          },
          {
            kind: "select",
            label: "分栏",
            title: "分栏",
            options: [
              { label: "单栏", args: [{ count: 1, gap: 30, separator: false }] },
              { label: "两栏", args: [{ count: 2, gap: 30, separator: false }] },
              { label: "两栏＋线", args: [{ count: 2, gap: 30, separator: true }] },
              { label: "三栏", args: [{ count: 3, gap: 24, separator: false }] },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "view",
    label: "视图",
    groups: [
      {
        label: "显示",
        items: [
          button("缩小", "缩小", "executePageScaleMinus", { icon: "ZoomOut24Regular" }),
          button("100%", "恢复缩放", "executePageScaleRecovery"),
          button("放大", "放大", "executePageScaleAdd", { icon: "ZoomIn24Regular" }),
          button("标尺", "显示/隐藏标尺", "executeToggleRuler", { icon: "Ruler24Regular" }),
          button("连页/分页", "切换连页与分页视图", "executePageMode", { icon: "DocumentOnePage24Regular" }),
          button("痕迹", "显示/隐藏修订与格式痕迹", "executeToggleTrace", { icon: "Eye24Regular" }),
          button("只读", "切换只读模式", "executeMode", { icon: "LockClosed24Regular" }),
        ],
      },
      {
        label: "工具",
        items: [
          button("字数统计", "字数统计", "executeWordTool", { icon: "TextWordCount24Regular" }),
          button("查找替换", "查找替换 (⌘F)", "executeSearch", { icon: "Search24Regular" }),
          button("打印", "打印 (⌘P)", "executePrint", { icon: "Print24Regular" }),
        ],
      },
    ],
  },
];
