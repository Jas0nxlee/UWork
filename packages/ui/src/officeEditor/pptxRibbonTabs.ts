/**
 * PPT 编辑位的**功能区数据**（对标 PowerPoint 的「开始 / 插入 / 视图」）。
 *
 * 复用 Word/Excel 那套功能区外壳（`officeRibbonModel` 的 item 类型 + `OfficeRibbon` 的宽度取舍与
 * 按钮态判定），只换数据与命令落点：命令由 `runPptxRibbonCommand` 执行。
 *
 * **只放真能执行的命令**——PPT 的"切换/动画/放映/审阅"这些我们做不到，就一个都不摆
 * （摆上去点了没反应，比没有更糟）。用到的形状能力都已有回归盯着：几何、粗斜下划线、字号、
 * 颜色、字体、对齐、项目符号、层级、复制删除、新建文本框、幻灯片增删排序。
 */
import type { RibbonTab } from "./officeRibbonModel.js";
import { button, colorSelect } from "./officeRibbonModel.js";
import { FONTS, HIGHLIGHT_COLORS, SIZES, TEXT_COLORS } from "./officeRibbonOptions.js";

export const PPTX_RIBBON_TABS: RibbonTab[] = [
  {
    id: "table",
    label: "表格",
    // 上下文标签：只有选中表格（光标在表格里）时才出现——与 Word/WPS 的「表格工具」同一个做法
    contextual: true,
    groups: [
      {
        label: "行与列",
        essential: true,
        items: [
          button("上方插入行", "在这一格上方插入一行", "pptxTableInsertRowAbove", {
            icon: "TableInsertRow24Regular",
          }),
          button("下方插入行", "在这一格下方插入一行", "pptxTableInsertRowBelow"),
          button("左侧插入列", "在这一格左侧插入一列", "pptxTableInsertColumnLeft", {
            icon: "TableInsertColumn24Regular",
          }),
          button("右侧插入列", "在这一格右侧插入一列", "pptxTableInsertColumnRight"),
          button("删除行", "删除这一格所在行", "pptxTableDeleteRow", {
            icon: "TableDeleteRow24Regular",
          }),
          button("删除列", "删除这一格所在列", "pptxTableDeleteColumn"),
        ],
      },
      {
        label: "合并",
        essential: true,
        items: [
          button(
            "合并单元格",
            "把选中的一片单元格合并成一格（保留左上角的文字）",
            "pptxTableMergeRange",
            { icon: "TableSimple24Regular" },
          ),
          button("向右合并", "把这一格与右边一格合并", "pptxTableMergeRight"),
          button("向下合并", "把这一格与下面一格合并", "pptxTableMergeDown"),
          button("拆分", "拆掉这一格参与的合并", "pptxTableSplit"),
        ],
      },
      {
        // 对齐方式：垂直在 a:tcPr@anchor、水平在段落 a:pPr@algn（OOXML 就是这么分工的）
        label: "对齐方式",
        items: [
          button("靠上", "单元格内容顶端对齐", "pptxTableCellAnchorTop", {
            icon: "AlignTop24Regular",
          }),
          button("垂直居中", "单元格内容垂直居中", "pptxTableCellAnchorMiddle"),
          button("靠下", "单元格内容底端对齐", "pptxTableCellAnchorBottom"),
          button("左对齐", "单元格文字左对齐", "pptxTableCellAlignLeft", {
            icon: "AlignLeft24Regular",
          }),
          button("水平居中", "单元格文字水平居中", "pptxTableCellAlignCenter"),
          button("右对齐", "单元格文字右对齐", "pptxTableCellAlignRight"),
        ],
      },
      {
        label: "单元格",
        items: [
          colorSelect("底纹", "单元格底纹", "Highlight24Regular", "highlight", HIGHLIGHT_COLORS),
          button("描边", "给这一格加四边边框", "pptxTableCellBorderOn", {
            icon: "BorderAll24Regular",
          }),
          button("去边框", "去掉这一格的边框", "pptxTableCellBorderOff"),
        ],
      },
      {
        label: "表格样式",
        items: [
          button("首行突出", "首行加粗/上底色（开关）", "pptxTableFirstRow", {
            icon: "TextBold24Regular",
          }),
          button("镶边行", "隔行底色（开关）", "pptxTableBandRow"),
        ],
      },
    ],
  },
  {
    id: "home",
    label: "开始",
    groups: [
      {
        label: "幻灯片",
        essential: true,
        items: [
          button("新建幻灯片", "新建一页（空白）", "pptxAddSlide", { icon: "SlideAdd24Regular" }),
          button("复制幻灯片", "复制当前这一页", "pptxDuplicateSlide", {
            icon: "Copy24Regular",
          }),
          button("删除幻灯片", "删除当前这一页", "pptxDeleteSlide", { icon: "Delete24Regular" }),
          button("上移", "当前页上移", "pptxMoveSlideUp", { icon: "ArrowUp24Regular" }),
          button("下移", "当前页下移", "pptxMoveSlideDown", { icon: "ArrowDown24Regular" }),
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
            options: FONTS.map((font) => ({ label: font.label, args: [font.value] })),
            current: (style): string | null =>
              style.font ? (String(style.font).split(",")[0] ?? null) : null,
          },
          {
            kind: "select",
            label: "字号",
            title: "字号",
            options: SIZES.map((size) => ({ label: String(size), args: [size] })),
            current: (style) => (style.size ? String(style.size) : null),
          },
          button("加粗", "加粗", "executeBold", { icon: "TextBold24Regular" }),
          button("斜体", "斜体", "executeItalic", { icon: "TextItalic24Regular" }),
          button("下划线", "下划线", "executeUnderline", { icon: "TextUnderline24Regular" }),
          button("删除线", "删除线", "executeStrikeout", { icon: "TextStrikethrough24Regular" }),
          colorSelect("字色", "文字颜色", "TextColor24Regular", "color", TEXT_COLORS),
        ],
      },
      {
        label: "段落",
        essential: true,
        items: [
          button("左", "左对齐", "executeRowFlex", { args: ["left"], icon: "AlignLeft24Regular" }),
          button("居中", "居中", "executeRowFlex", {
            args: ["center"],
            icon: "TextAlignCenter24Regular",
          }),
          button("右", "右对齐", "executeRowFlex", {
            args: ["right"],
            icon: "AlignRight24Regular",
          }),
          button("两端", "两端对齐", "executeRowFlex", { args: ["justify"] }),
          button("项目符号", "项目符号开/关", "pptxToggleBullet", {
            icon: "TextBulletList24Regular",
          }),
        ],
      },
      {
        label: "形状",
        items: [
          button("文本框", "新建文本框", "pptxAddTextBox", { icon: "Textbox24Regular" }),
          button("复制形状", "复制选中的形状", "pptxDuplicateShape", { icon: "Copy24Regular" }),
          button("删除形状", "删除选中的形状", "pptxDeleteShape", { icon: "Delete24Regular" }),
          button("上移一层", "把形状往上挪一层", "pptxShapeUp", { icon: "ArrowUp24Regular" }),
          button("下移一层", "把形状往下挪一层", "pptxShapeDown", { icon: "ArrowDown24Regular" }),
        ],
      },
    ],
  },
  {
    id: "insert",
    label: "插入",
    groups: [
      {
        label: "图像",
        items: [
          button("图片", "插入本机图片（等比放进页面中央）", "pptxInsertPicture", {
            icon: "Image24Regular",
            prompt: {
              message: "选择要插入的图片",
              at: 0,
              pick: { label: "选择图片", accept: "image/*", maxBytes: 8 * 1024 * 1024 },
            },
          }),
        ],
      },
      {
        label: "表格",
        items: [
          {
            kind: "table",
            label: "表格",
            title: "插入表格（拖动选行列，或直接填数字）",
          },
        ],
      },
      {
        label: "文本",
        items: [
          button("文本框", "在页面中部新建一个文本框", "pptxAddTextBox", {
            icon: "Textbox24Regular",
          }),
        ],
      },
      {
        label: "幻灯片",
        items: [
          button("新建幻灯片", "新建一页（空白）", "pptxAddSlide", { icon: "SlideAdd24Regular" }),
          button("复制这一页", "复制当前这一页", "pptxDuplicateSlide", { icon: "Copy24Regular" }),
        ],
      },
    ],
  },
  {
    id: "view",
    label: "视图",
    groups: [
      {
        label: "缩放",
        items: [
          button("放大", "放大画布", "pptxZoomIn", { icon: "ZoomIn24Regular" }),
          button("缩小", "缩小画布", "pptxZoomOut", { icon: "ZoomOut24Regular" }),
          button("适应宽度", "按可用宽度显示", "pptxZoomFit"),
          button("100%", "按 100% 显示", "pptxZoomReset", { args: [100] }),
        ],
      },
    ],
  },
];
