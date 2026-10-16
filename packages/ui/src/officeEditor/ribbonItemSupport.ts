/**
 * 功能区视图件的**支撑逻辑**：图标表、按钮态（激活/置灰）判定、下拉项到命令的映射。
 * 与 officeRibbonModel.ts 的数据一一对应，取值含义见该文件顶部注释。
 *
 * 从 RibbonItemViews 拆出：那个文件曾到 460 行，仓库规矩是单文件 ≤400 行。
 */
import {
  AlignLeft24Regular,
  AlignRight24Regular,
  ArrowDown24Regular,
  ArrowRedo24Regular,
  ArrowUndo24Regular,
  ArrowUp24Regular,
  CalendarLtr24Regular,
  CheckmarkCircle24Regular,
  CheckboxChecked24Regular,
  DismissCircle24Regular,
  ClearFormatting24Regular,
  Code24Regular,
  ColumnTriple24Regular,
  Delete24Regular,
  DividerShort24Regular,
  DocumentFit24Regular,
  DocumentOnePage24Regular,
  DocumentPageBottomCenter24Regular,
  DocumentPageBreak24Regular,
  Eye24Regular,
  FontDecrease24Regular,
  FontIncrease24Regular,
  Highlight24Regular,
  Image24Regular,
  Link24Regular,
  LockClosed24Regular,
  MathFormula24Regular,
  PaintBrush24Regular,
  Print24Regular,
  Ruler24Regular,
  Search24Regular,
  TableDeleteRow24Regular,
  TableInsertColumn24Regular,
  TableInsertRow24Regular,
  TableSimple24Regular,
  TaskListSquareLtr24Regular,
  TextAlignCenter24Regular,
  TextAlignJustify24Regular,
  TextBold24Regular,
  TextBulletListLtr24Regular,
  TextColor24Regular,
  TextFont24Regular,
  TextItalic24Regular,
  TextLineSpacing24Regular,
  TextNumberListLtr24Regular,
  TextQuote24Regular,
  TextStrikethrough24Regular,
  TextSubscript24Regular,
  TextSuperscript24Regular,
  TextUnderline24Regular,
  TextWordCount24Regular,
  ZoomIn24Regular,
  ZoomOut24Regular,
} from "@fluentui/react-icons";
import type { ComponentType } from "react";
import type { RibbonStyle } from "./officeRibbonModel.js";

/** 模型里 `icon` 字段写的是 Fluent 图标名，这里做名字到组件的查表。 */
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  ArrowUndo24Regular,
  ArrowRedo24Regular,
  PaintBrush24Regular,
  ClearFormatting24Regular,
  FontIncrease24Regular,
  FontDecrease24Regular,
  TextBold24Regular,
  TextItalic24Regular,
  TextUnderline24Regular,
  TextStrikethrough24Regular,
  TextSuperscript24Regular,
  TextSubscript24Regular,
  TextColor24Regular,
  TextFont24Regular,
  ArrowUp24Regular,
  ArrowDown24Regular,
  Highlight24Regular,
  AlignLeft24Regular,
  TextAlignCenter24Regular,
  AlignRight24Regular,
  TextAlignJustify24Regular,
  TextLineSpacing24Regular,
  TextBulletListLtr24Regular,
  TextNumberListLtr24Regular,
  TaskListSquareLtr24Regular,
  TableSimple24Regular,
  Image24Regular,
  Link24Regular,
  MathFormula24Regular,
  CalendarLtr24Regular,
  CheckmarkCircle24Regular,
  CheckboxChecked24Regular,
  DismissCircle24Regular,
  Code24Regular,
  TextQuote24Regular,
  DividerShort24Regular,
  DocumentPageBreak24Regular,
  DocumentPageBottomCenter24Regular,
  ColumnTriple24Regular,
  TableInsertRow24Regular,
  TableInsertColumn24Regular,
  TableDeleteRow24Regular,
  Delete24Regular,
  DocumentFit24Regular,
  ZoomOut24Regular,
  ZoomIn24Regular,
  Ruler24Regular,
  DocumentOnePage24Regular,
  Eye24Regular,
  LockClosed24Regular,
  TextWordCount24Regular,
  Search24Regular,
  Print24Regular,
};

export function iconOf(
  name: string | undefined,
): ComponentType<{ className?: string }> | undefined {
  return name ? ICONS[name] : undefined;
}

export function isActive(
  command: string,
  args: unknown[] | undefined,
  style: RibbonStyle | null,
): boolean {
  if (!style) return false;
  if (command === "executeRowFlex") return style.rowFlex === args?.[0];
  if (command === "executeList") return style.listType === args?.[0];
  const map: Record<string, boolean | undefined> = {
    executeBold: style.bold,
    executeItalic: style.italic,
    executeUnderline: style.underline,
    executeStrikeout: style.strikeout,
    // 格式刷是模式开关；撤销/重做不是（可用性只体现在置灰）
    executePainter: style.painter,
  };
  return map[command] === true;
}

export function isDisabled(command: string, style: RibbonStyle | null): boolean {
  if (!style) return false;
  if (command === "executeUndo") return style.undo === false;
  if (command === "executeRedo") return style.redo === false;
  return false;
}

/** 下拉项对应的命令（与 officeRibbonModel 的选项一一对应）。 */
export function optionsCommand(title: string): string {
  switch (title) {
    case "字体":
      return "executeFont";
    case "字号":
      return "executeSize";
    case "行距":
      return "executeRowMargin";
    case "项目符号与编号":
      return "executeList";
    case "文字颜色":
      return "executeColor";
    case "高亮（底纹）":
    case "单元格底色":
    case "单元格填充色":
      return "executeHighlight";
    case "数字格式":
      return "executeNumberFormat";
    case "单元格垂直对齐":
      return "executeSetTableCellVerticalAlign";
    case "纸张大小":
      return "executePaperSize";
    case "纸张方向":
      return "executePaperDirection";
    case "页边距":
      return "executeSetPaperMargin";
    case "分栏":
      return "executeSetColumns";
    case "插入内容控件（文本/列举/复选/单选/日期/数字）":
      return "executeInsertControlByType";
    default:
      return "executeNoop";
  }
}
