/**
 * 功能区各标签页的数据：开始 / 插入 / 表格工具 / 页面布局 / 视图。
 *
 * 命令名与参数形态**照抄 canvas-editor 官方 demo**（Hufe921/canvas-editor 的 src/main.ts，
 * 2477 行 vanilla TS 实现的 Word 级工具栏）；官方仓库还按菜单逐个写了 e2e
 * （text/format/title/list/row/table/image/hyperlink/date/checkbox/codeblock/latex/pagebreak/
 *  watermark/painter/search/print/pageLayout）——这就是我们功能面的依据。
 *
 * 引擎没有的能力不假装：canvas-editor **没有缩进（首行/悬挂缩进）命令**，
 * 所以对标 WPS 时那一排缩进按钮我们没有做（用列表层级与行距代之）。
 */
import {
  TEXT_COLORS,
  HIGHLIGHT_COLORS,
  FONTS,
  SIZES,
  STYLE_GALLERY,
} from "./officeRibbonOptions.js";
import { button, colorSelect, type RibbonTab } from "./officeRibbonModel.js";

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
        essential: true,
        items: [
          {
            kind: "select",
            label: "字体",
            title: "字体",
            // 显示名给用户看，值给引擎（跨平台字体栈，见 officeRibbonOptions 注释）
            options: FONTS.map((font) => ({ label: font.label, args: [font.value] })),
            current: (style): string | null =>
              FONTS.find((font) => style.font && String(style.font).includes(font.label))?.label ??
              (style.font ? (String(style.font).split(",")[0] ?? null) : null),
          },
          {
            kind: "select",
            label: "字号",
            title: "字号",
            options: SIZES.map((size) => ({ label: String(size), args: [size] })),
            current: (style) => (style.size ? String(style.size) : null),
          },
          button("加粗", "加粗 (⌘B)", "executeBold", { icon: "TextBold24Regular" }),
          button("斜体", "斜体 (⌘I)", "executeItalic", { icon: "TextItalic24Regular" }),
          button("下划线", "下划线 (⌘U)", "executeUnderline", { icon: "TextUnderline24Regular" }),
          {
            kind: "menu",
            label: "A",
            title: "文字效果（增大/减小字号、删除线、上标、下标、清除格式）",
            icon: "TextFont24Regular",
            items: [
              button("增大字号", "增大字号", "executeSizeAdd", { icon: "FontIncrease24Regular" }),
              button("减小字号", "减小字号", "executeSizeMinus", { icon: "FontDecrease24Regular" }),
              button("删除线", "删除线", "executeStrikeout", {
                icon: "TextStrikethrough24Regular",
              }),
              button("上标", "上标", "executeSuperscript", { icon: "TextSuperscript24Regular" }),
              button("下标", "下标", "executeSubscript", { icon: "TextSubscript24Regular" }),
              button("清除格式", "清除格式", "executeFormat", { icon: "ClearFormatting24Regular" }),
            ],
          },
          colorSelect("字色", "文字颜色", "TextColor24Regular", "color", TEXT_COLORS),
          colorSelect("底纹", "高亮（底纹）", "Highlight24Regular", "highlight", HIGHLIGHT_COLORS),
        ],
      },
      {
        label: "段落",
        essential: true,
        items: [
          button("左对齐", "左对齐 (⌘L)", "executeRowFlex", {
            args: ["left"],
            icon: "AlignLeft24Regular",
          }),
          button("居中", "居中 (⌘E)", "executeRowFlex", {
            args: ["center"],
            icon: "TextAlignCenter24Regular",
          }),
          button("右对齐", "右对齐 (⌘R)", "executeRowFlex", {
            args: ["right"],
            icon: "AlignRight24Regular",
          }),
          button("两端对齐", "两端对齐 (⌘J)", "executeRowFlex", {
            args: ["alignment"],
            icon: "TextAlignJustify24Regular",
          }),
          {
            kind: "select",
            label: "行距",
            title: "行距",
            icon: "TextLineSpacing24Regular",
            // 官方 demo 的 `data-rowmargin` 就是**倍数**（1.25/1.5/1.75/2/2.5/3），不是像素。
            options: [1.25, 1.5, 1.75, 2, 2.5, 3].map((ratio) => ({
              label: `${ratio} 倍行距`,
              args: [ratio],
            })),
          },
          button("无序列表", "项目符号", "executeList", {
            args: ["ul"],
            icon: "TextBulletListLtr24Regular",
          }),
          button("有序列表", "编号", "executeList", {
            args: ["ol"],
            icon: "TextNumberListLtr24Regular",
          }),
          button("任务列表", "任务列表", "executeList", {
            args: ["task"],
            icon: "TaskListSquareLtr24Regular",
          }),
        ],
      },
      { label: "样式", essential: true, items: [STYLE_GALLERY] },
    ],
  },
  {
    id: "insert",
    label: "插入",
    groups: [
      {
        label: "表格",
        essential: true,
        items: [{ kind: "table", label: "表格", title: "插入表格（拖动选行列，或直接填数字）" }],
      },
      {
        label: "插图与链接",
        essential: true,
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
          button("日期控件", "插入日期控件（点开选日期）", "executeInsertDateControl", {
            icon: "CalendarLtr24Regular",
          }),
          button("复选框控件", "插入复选框控件", "executeInsertCheckboxControl", {
            icon: "CheckboxChecked24Regular",
          }),
        ],
      },
      {
        label: "页面元素",
        items: [
          button("分隔线", "插入分隔线", "executeSeparator", { icon: "DividerShort24Regular" }),
          button("分页符", "插入分页符", "executePageBreak", {
            icon: "DocumentPageBreak24Regular",
          }),
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
          button("上方插行", "在上方插入行", "executeInsertTableTopRow", {
            icon: "TableInsertRow24Regular",
          }),
          button("下方插行", "在下方插入行", "executeInsertTableBottomRow"),
          button("左侧插列", "在左侧插入列", "executeInsertTableLeftCol", {
            icon: "TableInsertColumn24Regular",
          }),
          button("右侧插列", "在右侧插入列", "executeInsertTableRightCol"),
          button("删行", "删除当前行", "executeDeleteTableRow", {
            icon: "TableDeleteRow24Regular",
          }),
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
          colorSelect("底色", "单元格底色", "Highlight24Regular", "highlight", HIGHLIGHT_COLORS),
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
        essential: true,
        items: [
          {
            kind: "select",
            label: "纸张",
            title: "纸张大小",
            icon: "DocumentFit24Regular",
            // 值就是引擎的像素口径（96dpi），见 engineCommands.PAPER_PRESETS
            options: [
              { label: "A4（默认）", args: ["A4"] },
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
        essential: true,
        items: [
          button("缩小", "缩小（⌘-）", "executePageScaleMinus", { icon: "ZoomOut24Regular" }),
          {
            kind: "select",
            label: "缩放",
            title: "显示比例",
            icon: "ZoomIn24Regular",
            options: [0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => ({
              label: `${Math.round(value * 100)}%`,
              args: [value],
            })),
            current: (style) => `${Math.round((style.scale ?? 1) * 100)}%`,
          },
          button("放大", "放大（⌘+）", "executePageScaleAdd", { icon: "ZoomIn24Regular" }),
          button("标尺", "显示/隐藏标尺", "executeToggleRuler", { icon: "Ruler24Regular" }),
          button("分页/连页", "切换分页与连页视图", "executePageMode", {
            icon: "DocumentOnePage24Regular",
          }),
          button("痕迹", "显示/隐藏修订痕迹", "executeToggleTrace", { icon: "Eye24Regular" }),
          button("只读", "切换只读模式", "executeMode", { icon: "LockClosed24Regular" }),
        ],
      },
      {
        label: "工具",
        items: [
          button("字数统计", "字数统计", "executeWordCount", { icon: "TextWordCount24Regular" }),
          { kind: "find", label: "查找替换", title: "查找与替换" },
          button("打印", "打印（⌘P）", "executePrint", { icon: "Print24Regular" }),
        ],
      },
    ],
  },
];
