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
import { applyStructureEdit, buildMatrix, type StructureEdit } from "./excelStructure.js";
import { cellEntries } from "./xlsxWorkbook.js";
import { columnLetter } from "./xlsxMapping.js";

export interface ExcelCommandContext {
  api: () => WorkbookInstance | null;
  setStatus: (message: string) => void;
  /** 拿当前所有表（保存路径要用）。 */
  getSheets: () => Sheet[];
  /**
   * 报告一次**行列结构操作**：保存时要在文件上做同样的整行/整列搬移（连批注、行高一起搬），
   * 单靠"差分写回"只会挪值。回调由编辑位提供。
   */
  recordStructureEdit?: (edit: StructureEdit, sheetName: string) => void;
}

/**
 * 引擎新加的工作表（`addSheet`）**没有 `data` 矩阵**（只有 name/id/row/column/config），
 * 而引擎的每一次写都是 `sheet.data[row][column] = …` —— 对着一张没有矩阵的表下手就崩（实测白屏）。
 * 所以动任何命令之前先把它补齐：矩阵由 celldata 或空表攒出来，再整表回灌。
 */
function ensureSheetData(api: WorkbookInstance, sheet: Sheet | undefined): Sheet | undefined {
  if (!sheet) return sheet;
  if (Array.isArray(sheet.data) && sheet.data.length > 0) return sheet;
  const rows = sheet.row && sheet.row > 0 ? sheet.row : 84;
  const columns = sheet.column && sheet.column > 0 ? sheet.column : 26;
  const next: Sheet = {
    ...sheet,
    row: rows,
    column: columns,
    data: buildMatrix(cellEntries(sheet), rows, columns),
    celldata: undefined,
  };
  api.updateSheet([next]);
  return next;
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
  // 边界**以数据矩阵为准**（引擎就是往 `sheet.data[row][col]` 里写，矩阵没有的行/列就是越界）：
  // `sheet.row/column` 是"表格规模"，两者不一致时（例如刚被整表替换过）以矩阵为准才安全。
  const rows = sheet?.data?.length ?? sheet?.row ?? 100;
  const columns = sheet?.data?.[0]?.length ?? sheet?.column ?? 26;

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
  // 当前表**问引擎要**（api.getSheet()），不要拿 status 猜：
  // 新增工作表之后 status 与"引擎当前在哪张表"会不一致，猜错就会用另一张表的规模去裁剪，
  // 于是写格式越界 → 引擎崩（实测：跑完整个命令矩阵后 excelAutoSum 处白屏）。
  const sheets = context.getSheets();
  const activeSheet = ensureSheetData(
    api,
    api.getSheet?.() ?? sheets.find((sheet) => sheet.status === 1) ?? sheets[0],
  );
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
    case "excelInsertRowAbove":
    case "excelInsertRowBelow":
    case "excelInsertColumnLeft":
    case "excelInsertColumnRight":
    case "excelDeleteRow":
    case "excelDeleteColumn": {
      // 这一组**不走引擎的结构化 API**（那条路会把表状态弄坏，见 excelStructure.ts 顶部）：
      // 自己算好新表，再用 updateSheet 整表替换。
      if (!activeSheet) return true;
      const isRow = command.includes("Row");
      const remove = command.startsWith("excelDelete");
      const edit: StructureEdit = remove
        ? {
            kind: isRow ? "row" : "column",
            mode: "delete",
            index: isRow ? (range[0]?.row?.[0] ?? 0) : (range[0]?.column?.[0] ?? 0),
            count: isRow
              ? Math.max(1, (range[0]?.row?.[1] ?? 0) - (range[0]?.row?.[0] ?? 0) + 1)
              : Math.max(1, (range[0]?.column?.[1] ?? 0) - (range[0]?.column?.[0] ?? 0) + 1),
          }
        : {
            kind: isRow ? "row" : "column",
            mode: "insert",
            index: isRow
              ? (range[0]?.row?.[0] ?? 0) + (command.endsWith("Below") ? 1 : 0)
              : (range[0]?.column?.[0] ?? 0) + (command.endsWith("Right") ? 1 : 0),
            count: 1,
          };
      if (remove) {
        const size = isRow ? (activeSheet.row ?? 0) : (activeSheet.column ?? 0);
        // 表就这么大：删到一行/一列都不剩的话引擎直接没法工作，先说清楚
        if (size - edit.count < 1) {
          context.setStatus(
            `${isRow ? "行" : "列"}数不够删（当前 ${size} 条，要删 ${edit.count} 条）——表格至少要留一条`,
          );
          return true;
        }
      }
      const result = applyStructureEdit(activeSheet, cellEntries(activeSheet), edit);
      context.recordStructureEdit?.(edit, activeSheet.name);
      api.updateSheet([result.sheet]);
      api.calculateFormula();
      api.setSelection([
        {
          row: isRow
            ? [edit.index, remove ? Math.max(edit.index, edit.index) : edit.index]
            : [0, 0],
          column: isRow
            ? [0, 0]
            : [edit.index, remove ? Math.max(edit.index, edit.index) : edit.index],
        },
      ]);
      const label = isRow ? `第 ${edit.index + 1} 行` : `${columnLetter(edit.index)} 列`;
      context.setStatus(
        remove
          ? `已删除 ${label}${edit.count > 1 ? ` 起 ${edit.count} 条` : ""}（其余内容上移/左移，公式引用已跟着改）`
          : `已在 ${label}${command.endsWith("Below") ? "下方" : command.endsWith("Right") ? "右侧" : "上方/左侧"}插入`,
      );
      return true;
    }
    case "excelSelectAll": {
      // 只选**表格实际范围**：选到 0..999 这种越界范围，后面任何一次写格式都会把引擎写崩
      const rows = activeSheet?.row ?? 100;
      const columns = activeSheet?.column ?? 26;
      api.setSelection([{ row: [0, rows - 1], column: [0, columns - 1] }]);
      context.setStatus(`已选中整张表（${rows} 行 × ${columns} 列）`);
      return true;
    }
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
