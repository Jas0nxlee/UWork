/**
 * Excel 编辑位的功能区数据（对标 Excel 的「开始 / 插入 / 公式 / 视图」）。
 *
 * 复用 Word 那套功能区外壳（officeRibbonModel 的 item 类型 + OfficeRibbon 的宽度取舍 + 按钮态判定），
 * 只换数据与命令落点：命令由 excelCommands.runExcelCommand 执行。
 * 命令名沿用 executeBold/executeRowFlex/executeColor/executeHighlight 这几个同名动作，
 * 于是"加粗亮不亮""左对齐亮不亮"不用再写一份判定（见 ribbonItemSupport.isActive）。
 *
 * 与 Word 的差异都写在这里：表格没有"段落/缩进"，但有**数字格式/合并居中/冻结**——按 Excel 的分组放。
 */
import type { RibbonTab } from "./officeRibbonModel.js";
import { button, colorSelect } from "./officeRibbonModel.js";
import { FONTS, HIGHLIGHT_COLORS, SIZES, TEXT_COLORS } from "./officeRibbonOptions.js";
import { NUMBER_FORMATS } from "./excelCommands.js";

export const EXCEL_RIBBON_TABS: RibbonTab[] = [
  {
    id: "home",
    label: "开始",
    groups: [
      {
        label: "历史",
        items: [
          button("撤销", "撤销 (⌘Z)", "executeUndo", { icon: "ArrowUndo24Regular" }),
          button("重做", "重做 (⇧⌘Z)", "executeRedo", { icon: "ArrowRedo24Regular" }),
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
          button("删除线", "删除线", "executeStrikeout", { icon: "TextStrikethrough24Regular" }),
          colorSelect("字色", "文字颜色", "TextColor24Regular", "color", TEXT_COLORS),
          colorSelect("填充", "单元格填充色", "Highlight24Regular", "highlight", HIGHLIGHT_COLORS),
        ],
      },
      {
        label: "对齐",
        essential: true,
        items: [
          button("左对齐", "左对齐", "executeRowFlex", {
            args: ["left"],
            icon: "AlignLeft24Regular",
          }),
          button("居中", "水平居中", "executeRowFlex", {
            args: ["center"],
            icon: "TextAlignCenter24Regular",
          }),
          button("右对齐", "右对齐", "executeRowFlex", {
            args: ["right"],
            icon: "AlignRight24Regular",
          }),
          button("自动换行", "自动换行", "excelWrapText", { icon: "TextWordCount24Regular" }),
          button("合并居中", "合并并居中", "excelMergeCenter", { icon: "TableSimple24Regular" }),
          button("取消合并", "取消合并", "excelUnmerge"),
        ],
      },
      {
        label: "数字",
        items: [
          {
            kind: "select",
            label: "格式",
            title: "数字格式",
            options: NUMBER_FORMATS.map((preset) => ({
              label: preset.label,
              args: [preset.label],
            })),
          },
        ],
      },
      {
        // 行列结构操作走的是**我们自己算 + 整表回灌**（excelStructure.ts）：引擎自己的
        // insertRowOrColumn/deleteRowOrColumn 会把表状态弄坏（实测 data 变 0 行后崩、白屏）。
        // 网格线开关仍然没有：引擎的 updateSheet 只认数据矩阵、不认表级字段，做了也是"点了没反应"。
        // 复现与取舍写在 specs/office-editors-triad.md。
        label: "行列",
        items: [
          button("插入行", "在上方插入一行", "excelInsertRowAbove", {
            icon: "TableInsertRow24Regular",
          }),
          button("在下方插入行", "在下方插入一行", "excelInsertRowBelow"),
          button("插入列", "在左侧插入一列", "excelInsertColumnLeft", {
            icon: "TableInsertColumn24Regular",
          }),
          button("在右侧插入列", "在右侧插入一列", "excelInsertColumnRight"),
          button("删除行", "删除所选行（内容上移）", "excelDeleteRow", {
            icon: "TableDeleteRow24Regular",
          }),
          button("删除列", "删除所选列（内容左移）", "excelDeleteColumn"),
          button("整表", "选中整张表", "excelSelectAll", { icon: "TableSimple24Regular" }),
        ],
      },
      {
        label: "清除",
        items: [
          button("清内容", "清除选区内容（保留格式）", "excelClearContent", {
            icon: "Delete24Regular",
          }),
          button("清格式", "清除选区格式", "excelClearFormat", {
            icon: "ClearFormatting24Regular",
          }),
        ],
      },
    ],
  },
  {
    id: "insert",
    label: "插入",
    groups: [
      {
        label: "行与列",
        items: [
          button("行（上）", "在上方插入一行", "excelInsertRowAbove", {
            icon: "TableInsertRow24Regular",
          }),
          button("行（下）", "在下方插入一行", "excelInsertRowBelow"),
          button("列（左）", "在左侧插入一列", "excelInsertColumnLeft", {
            icon: "TableInsertColumn24Regular",
          }),
          button("列（右）", "在右侧插入一列", "excelInsertColumnRight"),
        ],
      },
      {
        label: "工作表",
        items: [
          button("新建工作表", "新增一张工作表", "excelAddSheet", { icon: "TableSimple24Regular" }),
        ],
      },
      {
        label: "计算",
        items: [
          button("自动求和", "在选区下方写入 =SUM(…)", "excelAutoSum", {
            icon: "MathFormula24Regular",
          }),
        ],
      },
    ],
  },
  {
    id: "formula",
    label: "公式",
    groups: [
      {
        label: "计算",
        items: [
          button("自动求和", "在选区下方写入 =SUM(…)", "excelAutoSum", {
            icon: "MathFormula24Regular",
          }),
          button("重新计算", "重新计算所有公式", "excelRecalculate", {
            icon: "ArrowRedo24Regular",
          }),
        ],
      },
    ],
  },
  {
    id: "view",
    label: "视图",
    groups: [
      {
        label: "窗格",
        items: [
          button("冻结首行", "冻结第一行", "excelFreezeFirstRow", { icon: "LockClosed24Regular" }),
          button("冻结首列", "冻结第一列", "excelFreezeFirstColumn"),
          button("冻结行列", "同时冻结首行首列", "excelFreezeBoth"),
          button("取消冻结", "取消冻结", "excelUnfreeze"),
        ],
      },
    ],
  },
];
