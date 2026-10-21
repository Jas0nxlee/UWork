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
import { FONTS, SIZES, TEXT_COLORS } from "./officeRibbonOptions.js";

export const PPTX_RIBBON_TABS: RibbonTab[] = [
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
