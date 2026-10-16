/**
 * Excel 编辑位的**命令调度**：把功能区的动作翻译成 fortune-sheet 的 WorkbookInstance API。
 *
 * 与 Word 那边的 officeEditorCommands 同职责、同口径：**参数形态照官方 demo 来**，不自己发明。
 * 这里踩过的坑写在各自分支里（合并的 type 枚举、行列索引是零基、冻结的类型串…）。
 *
 * 为什么命令名沿用 Word 那套（executeBold/executeRowFlex…）：功能区的按钮态（加粗是否亮着）
 * 是按**命令名 + 当前格式**算的（ribbonItemSupport），沿用同一套名字就不用再写一份判定；
 * run 由各自的编辑位注入，命令落到哪套引擎上由调度器决定。
 */
import type { Range, Sheet, SingleRange } from "@fortune-sheet/core";
import type { WorkbookInstance } from "@fortune-sheet/react";
import { columnLetter } from "./xlsxMapping.js";

export interface ExcelCommandContext {
  api: () => WorkbookInstance | null;
  setStatus: (message: string) => void;
  /** 表级别改动（网格线/冻结）要回写整份 sheets，用这个拿当前表。 */
  getSheets: () => Sheet[];
}

/** "清除格式"要清的所有格式位（值一律 null，引擎按缺省处理）。 */
const STYLE_ATTRIBUTES = ["bl", "it", "un", "cl", "bg", "fc", "ff", "fs", "ht", "vt", "tb"] as const;

/** "B2" / "B2:C3" → 单块选区（引擎的 getSelectionCoordinates 给的地址格式）。 */
function parseCoordinate(text: string): SingleRange | null {
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(text.trim());
  if (!match) return null;
  const [, firstColumn = "A", firstRow = "1", lastColumn, lastRow] = match;
  const toIndex = (letters: string): number => {
    let value = 0;
    for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
    return value - 1;
  };
  const top = Number(firstRow) - 1;
  const left = toIndex(firstColumn);
  return {
    row: [top, lastRow ? Number(lastRow) - 1 : top],
    column: [left, lastColumn ? toIndex(lastColumn) : left],
  };
}

/**
 * 当前选区，**按表格边界裁剪**。
 *
 * 两个坑都在这里：
 *  ① 取选区要用 `getSelectionCoordinates()`（地址字符串），**不能用 getSelection()**：
 *     实测这套实例里 getSelection() 返回的是 `[{row:[0,null],column:[0,null]}]` 这种没设上的占位值，
 *     于是任何范围操作都会静默落到 A1（"点了加粗没反应、其实加粗到了 A1"就是这样来的）；
 *  ② 引擎的 setCellFormat/clearCell 直接写 `sheet.data[row][column]`，**越界即崩**
 *    （实测"整表"选中 0..999 行之后清除格式 → `Cannot set properties of undefined` → 整个编辑区白屏）。
 */
function selectionOf(api: WorkbookInstance, sheet: Sheet | undefined): Range {
  const rows = sheet?.row ?? sheet?.data?.length ?? 100;
  const columns = sheet?.column ?? sheet?.data?.[0]?.length ?? 26;

  const clamp = (single: SingleRange): SingleRange => {
    const [top = 0, bottom = 0] = single.row;
    const [left = 0, right = 0] = single.column;
    return {
      row: [
        Math.max(0, Math.min(Math.min(top, bottom), rows - 1)),
        Math.max(0, Math.min(Math.max(top, bottom), rows - 1)),
      ],
      column: [
        Math.max(0, Math.min(Math.min(left, right), columns - 1)),
        Math.max(0, Math.min(Math.max(left, right), columns - 1)),
      ],
    };
  };

  const fromCoordinates = (api.getSelectionCoordinates?.() ?? [])
    .map(parseCoordinate)
    .filter((single): single is SingleRange => single !== null);
  if (fromCoordinates.length > 0) return fromCoordinates.map(clamp);

  const selection = api.getSelection();
  const usable = (selection ?? []).filter(
    (single) => Number.isFinite(single?.row?.[1]) && Number.isFinite(single?.column?.[1]),
  );
  if (usable.length > 0) return usable.map((single) => clamp(single));
  // 都没有就兜底成 A1（引擎在无选区时直接不做事）
  return [{ row: [0, 0], column: [0, 0] }];
}

/** 选区的可读地址（`A1:C3`），状态栏里回显"这次改的是哪一块"。 */
export function rangeLabel(range: Range): string {
  const first = range[0];
  const from = `${columnLetter(first?.column?.[0] ?? 0)}${(first?.row?.[0] ?? 0) + 1}`;
  const to = `${columnLetter(first?.column?.[1] ?? 0)}${(first?.row?.[1] ?? 0) + 1}`;
  return from === to ? from : `${from}:${to}`;
}

/** 选区地址文字（`A1:C3`），给状态栏与"整行/整列"提示用。 */
export function selectionLabel(api: WorkbookInstance | null): string {
  const coordinates = api?.getSelectionCoordinates?.();
  return coordinates && coordinates.length > 0 ? coordinates.join(",") : "";
}

/** 数字格式：对标 Excel 「数字」组的下拉（值就是 exceljs/fortune-sheet 都认的格式串）。 */
export const NUMBER_FORMATS: Array<{ label: string; format: string; type: string }> = [
  { label: "常规", format: "General", type: "g" },
  { label: "数字", format: "0.00", type: "n" },
  { label: "整数", format: "0", type: "n" },
  { label: "千分位", format: "#,##0.00", type: "n" },
  { label: "百分比", format: "0.00%", type: "n" },
  { label: "货币", format: "¥#,##0.00", type: "n" },
  { label: "日期", format: "yyyy-MM-dd", type: "d" },
  { label: "文本", format: "@", type: "s" },
];

/**
 * 跑一条 Excel 命令。返回 false 表示"这条命令不归 Excel 管"（调用方可以据此提示）。
 */
export function runExcelCommand(
  context: ExcelCommandContext,
  command: string,
  args: unknown[] = [],
): boolean {
  const api = context.api();
  if (!api) {
    context.setStatus("表格还没加载好，稍等一下再试");
    return true;
  }
  const sheets = context.getSheets();
  const activeSheet = sheets.find((sheet) => sheet.status === 1) ?? sheets[0];
  const range = selectionOf(api, activeSheet);
  const first = range[0];
  const cell = { row: first?.row?.[0] ?? 0, column: first?.column?.[0] ?? 0 };

  switch (command) {
    case "executeUndo":
      api.handleUndo();
      return true;
    case "executeRedo":
      api.handleRedo();
      return true;
    case "executeBold":
    case "executeItalic":
    case "executeUnderline":
    case "executeStrikeout": {
      const attribute = { executeBold: "bl", executeItalic: "it", executeUnderline: "un", executeStrikeout: "cl" }[
        command
      ] as "bl" | "it" | "un" | "cl";
      // 读回来的是"引擎规范化过的值"：开着是 1，关着是字符串 "0"（不是 0）。
      // 拿 `current === 1` 当开关判断的话，取消加粗会变成"再加粗一次"（实测踩过）
      const current = api.getCellValue(cell.row, cell.column, { type: attribute });
      const isOn = current === 1 || current === "1";
      api.setCellFormatByRange(attribute, isOn ? 0 : 1, range);
      context.setStatus(`${isOn ? "已取消" : "已应用"}格式（${rangeLabel(range)}）`);
      return true;
    }
    case "executeColor":
      api.setCellFormatByRange("fc", args[0] ?? null, range);
      return true;
    case "executeHighlight":
      // 表格里的"底纹"就是单元格填充色（与 Word 的高亮同一个按钮位）
      api.setCellFormatByRange("bg", args[0] ?? null, range);
      return true;
    case "executeFont":
      api.setCellFormatByRange("ff", args[0] ?? undefined, range);
      return true;
    case "executeSize":
      api.setCellFormatByRange("fs", args[0] ?? undefined, range);
      return true;
    case "executeRowFlex": {
      const horizontal = { left: 1, center: 0, right: 2 }[String(args[0])];
      if (horizontal === undefined) {
        context.setStatus(`表格里没有「${String(args[0])}」这种对齐，只有左/居中/右`);
        return true;
      }
      api.setCellFormatByRange("ht", horizontal, range);
      return true;
    }
    case "excelWrapText": {
      const current = api.getCellValue(cell.row, cell.column, { type: "tb" });
      api.setCellFormatByRange("tb", current === "2" ? "0" : "2", range);
      context.setStatus(current === "2" ? "已取消自动换行" : "已开启自动换行");
      return true;
    }
    case "excelMergeCenter":
      // 枚举是**带连字符**的："merge-all" / "merge-horizontal" / "merge-vertical"（取消是 "merge-cancel"）。
      // 写成 "mergeAll" 引擎一个分支都不匹配 —— 静默什么都不做（实测踩过）。
      api.mergeCells(range, "merge-all");
      api.setCellFormatByRange("ht", 0, range);
      context.setStatus("已合并并居中（再点「取消合并」可还原）");
      return true;
    case "excelUnmerge":
      api.cancelMerge(range);
      context.setStatus("已取消合并");
      return true;
    case "executeNumberFormat": {
      const preset = NUMBER_FORMATS.find((item) => item.label === args[0]) ?? NUMBER_FORMATS[0];
      if (!preset) return true;
      api.setCellFormatByRange("ct", { fa: preset.format, t: preset.type }, range);
      context.setStatus(`数字格式：${preset.label}`);
      return true;
    }
    case "excelClearContent":
      for (const single of range) {
        const [top = 0, bottom = 0] = single.row;
        const [left = 0, right = 0] = single.column;
        for (let row = top; row <= bottom; row += 1) {
          for (let column = left; column <= right; column += 1) {
            api.clearCell(row, column);
          }
        }
      }
      context.setStatus("已清除选区内容（格式保留）");
      return true;
    case "excelClearFormat":
      // 一律写 null（引擎的 normalizedCellAttr 对每个属性都有 null 兜底）。
      // 踩过的坑：底纹传数字 0 会让 canvas 渲染时走 `value.indexOf("rgba")` 直接崩（_value.indexOf is not a function），
      // 于是"清除格式"一点，整张表就白屏——回归检查就是为了拦住这种。
      for (const attribute of STYLE_ATTRIBUTES) {
        api.setCellFormatByRange(attribute, null, range);
      }
      context.setStatus("已清除选区格式");
      return true;
    case "excelAddSheet":
      api.addSheet();
      context.setStatus("已新增工作表（双击表名可以改名）");
      return true;
    case "excelAutoSum": {
      // 自动求和（Excel 的 Σ）：往选区**下面那格**写 =SUM(选区列)，与 Excel 的行为一致
      const column = range[0]?.column?.[0] ?? 0;
      const topRow = range[0]?.row?.[0] ?? 0;
      const bottomRow = range[0]?.row?.[1] ?? topRow;
      const letter = columnLetter(column);
      const formula = `=SUM(${letter}${topRow + 1}:${letter}${bottomRow + 1})`;
      // 目标格必须落在表格内：引擎写越界行会直接崩（targetSheetData[row] 不存在）
      const rows = activeSheet?.row ?? 100;
      if (bottomRow + 1 >= rows) {
        context.setStatus(`选区已经到表格底部（第 ${rows} 行），往下没有位置写合计`);
        return true;
      }
      api.setCellFormat(bottomRow + 1, column, "f", formula);
      api.calculateFormula();
      context.setStatus(`已在第 ${bottomRow + 2} 行、${letter} 列写入 ${formula}`);
      return true;
    }
    case "excelRecalculate":
      api.calculateFormula();
      context.setStatus("已重新计算所有公式");
      return true;
    case "excelFreezeFirstRow":
    case "excelFreezeFirstColumn":
    case "excelFreezeBoth":
    case "excelUnfreeze": {
      // 冻结是**表级**设置：freeze() 只改内存里的冻结状态，落盘要靠 updateSheet 写回表数据
      const type =
        command === "excelFreezeFirstRow"
          ? "row"
          : command === "excelFreezeFirstColumn"
            ? "column"
            : command === "excelFreezeBoth"
              ? "both"
              : "row";
      if (command === "excelUnfreeze") {
        api.freeze("row", { row: 0, column: 0 });
      } else {
        api.freeze(type as "row" | "column" | "both", { row: 1, column: 1 });
      }
      context.setStatus(command === "excelUnfreeze" ? "已取消冻结" : "已冻结首行/首列");
      return true;
    }
    default:
      context.setStatus(`表格编辑暂不支持「${command}」`);
      return false;
  }
}
