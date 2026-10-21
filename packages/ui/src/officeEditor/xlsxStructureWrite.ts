/**
 * 把**行列结构操作**落到 exceljs 工作表上（`xlsxWorkbook` 的写回在差分之前调用它）。
 *
 * 这一层存在的理由：exceljs 的 `spliceRows/spliceColumns` 只搬值/样式/行高，批注、数据验证、
 * 公式文本都不会跟着走（都是实测出来的）。所以"整行/整列搬移"这件事在这里补齐：
 *   - `applyStructureToWorksheet`：整行/整列的插入与删除；
 *   - `moveDecorations`：批注与数据验证跟着搬（批注只能用内部字段清——`note = null` 会让写出直接抛）；
 *   - `rewriteWorksheetFormulas`：文件里的公式按同一个操作改写 A1 引用；
 *   - `rebuildMerges`：结构操作之后重建合并区域（splice 之后 exceljs 的合并表与目标状态可能不一致，
 *     增量差分实测会抛 `Cannot merge already merged cells`）。
 * 拆成独立文件的原因：仓库规矩是单文件 ≤400 行（xlsxWorkbook 上一版 510 行）。
 */
import type { Cell as ExcelCell, Worksheet } from "exceljs";
import { shiftFormula, transformIndex, type StructureEdit } from "./excelStructure.js";

/** 只需要"工作表 + 前后两份表的合并配置"，不依赖 xlsxWorkbook 的私有类型。 */
export interface SheetPairLike {
  worksheet: Worksheet;
  baseline: { config?: { merge?: Record<string, unknown> } } | undefined;
  current: { config?: { merge?: Record<string, unknown> } };
}

/**
 * exceljs 的 `spliceRows/spliceColumns` 只搬**值、样式、行高**——批注与数据验证不会跟着走
 * （实测：插入一行后批注留在原地、内容却下去了，等于把批注标到了别的行上）。
 * 所以这里自己搬：先收起来 → 清掉 → 结构操作 → 按新位置写回。
 *
 * 清批注只能用内部字段：exceljs 没有"删批注"的公开 API，而 `cell.note = null` 会让写出直接抛
 * （`Cannot read properties of null (reading 'margins')`，实测）。字段名万一变了就退化成"批注不动"，
 * 不会写坏文件——所以这里带 `in` 判断。
 */
export type WorksheetWithValidations = Worksheet & {
  dataValidations?: {
    model: Record<string, unknown>;
    add: (address: string, validation: unknown) => unknown;
  };
};

export function moveDecorations(
  worksheet: WorksheetWithValidations,
  edit: StructureEdit,
  phase: "collect" | "restore",
  store: {
    notes: Array<{ r: number; c: number; note: unknown }>;
    validations: Array<{ address: string; validation: unknown }>;
  },
): void {
  if (phase === "collect") {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        if (cell.note) store.notes.push({ r: row.number, c: columnNumber, note: cell.note });
      });
    });
    const validations = worksheet.dataValidations?.model ?? {};
    for (const [address, validation] of Object.entries(validations)) {
      if (validation) store.validations.push({ address, validation });
    }
    for (const item of store.notes) {
      const cell = worksheet.getCell(item.r, item.c) as ExcelCell & { _comment?: unknown };
      if ("_comment" in cell) cell._comment = undefined;
    }
    if (worksheet.dataValidations) worksheet.dataValidations.model = {};
    return;
  }
  const shiftAddress = (address: string): string | null => {
    const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(address);
    if (!match) return null;
    const [, firstColumn = "A", firstRow = "1", lastColumn, lastRow] = match;
    const toIndex = (letters: string): number => {
      let value = 0;
      for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
      return value - 1;
    };
    const toLetters = (index: number): string => {
      let value = index + 1;
      let letters = "";
      while (value > 0) {
        const rest = (value - 1) % 26;
        letters = String.fromCharCode(65 + rest) + letters;
        value = Math.floor((value - rest - 1) / 26);
      }
      return letters;
    };
    const isRow = edit.kind === "row";
    const start = transformIndex(
      Number(firstRow) - 1,
      isRow ? edit : { ...edit, index: 0, count: 0 },
    );
    const startColumn = toIndex(firstColumn);
    const end = lastRow
      ? transformIndex(Number(lastRow) - 1, isRow ? edit : { ...edit, index: 0, count: 0 })
      : start;
    const endColumn = lastColumn ? toIndex(lastColumn) : startColumn;
    if (start === null || end === null) return null;
    const shiftedColumnStart = isRow
      ? startColumn
      : (transformIndex(startColumn, edit) ?? startColumn);
    const shiftedColumnEnd = isRow ? endColumn : (transformIndex(endColumn, edit) ?? endColumn);
    return lastRow
      ? `${toLetters(shiftedColumnStart)}${start + 1}:${toLetters(shiftedColumnEnd)}${end + 1}`
      : `${toLetters(shiftedColumnStart)}${start + 1}`;
  };
  for (const item of store.notes) {
    const shifted = transformIndex(item.r - 1, edit);
    if (shifted === null) continue;
    const column = edit.kind === "column" ? transformIndex(item.c - 1, edit) : item.c - 1;
    if (column === null) continue;
    worksheet.getCell(shifted + 1, column + 1).note = item.note as never;
  }
  for (const item of store.validations) {
    const address = shiftAddress(item.address);
    if (!address) continue;
    worksheet.dataValidations?.add(address, item.validation as never);
  }
}

/** 把一次结构操作落到工作表上：插入/删除整行或整列（值/样式/行高由 exceljs 搬，批注与数据验证由我们搬）。 */
export function applyStructureToWorksheet(
  worksheet: Worksheet,
  edit: StructureEdit,
  columns: number,
): void {
  const start = edit.index + 1;
  if (edit.kind === "row") {
    if (edit.mode === "insert") {
      const blank = Array.from({ length: edit.count }, () =>
        Array.from({ length: Math.max(columns, worksheet.columnCount || 0) }, () => null),
      );
      worksheet.spliceRows(start, 0, ...blank);
    } else {
      worksheet.spliceRows(start, edit.count);
    }
    return;
  }
  if (edit.mode === "insert") {
    // spliceColumns 的插入值是"每列一个数组（该列的行）"，给 null 会被 exceljs 拒绝
    const blankColumn = Array.from({ length: Math.max(worksheet.rowCount || 0, 1) }, () => null);
    const blanks = Array.from({ length: edit.count }, () => blankColumn);
    worksheet.spliceColumns(start, 0, ...blanks);
  } else {
    worksheet.spliceColumns(start, edit.count);
  }
}

/** 一张表的合并区域集合（`r_c` 锚点 → "A1:B2"）。 */
function mergeRanges(
  sheet: { config?: { merge?: Record<string, unknown> } } | undefined,
): Set<string> {
  const out = new Set<string>();
  const merges = (sheet?.config?.merge ?? {}) as Record<
    string,
    { r: number; c: number; rs: number; cs: number }
  >;
  for (const rect of Object.values(merges)) {
    if (rect) out.add(rangeOf(rect));
  }
  return out;
}

function rangeOf(rect: { r: number; c: number; rs: number; cs: number }): string {
  const toColumn = (index: number): string => {
    let value = index + 1;
    let letters = "";
    while (value > 0) {
      const rest = (value - 1) % 26;
      letters = String.fromCharCode(65 + rest) + letters;
      value = Math.floor((value - rest - 1) / 26);
    }
    return letters;
  };
  return `${toColumn(rect.c)}${rect.r + 1}:${toColumn(rect.c + rect.cs - 1)}${rect.r + rect.rs}`;
}

export function rebuildMerges(pair: SheetPairLike, fileMerges: string[]): number {
  const target = mergeRanges(pair.current);
  const candidates = new Set([...mergeRanges(pair.baseline), ...target, ...fileMerges]);
  let changed = 0;
  for (const range of candidates) {
    if (!target.has(range)) changed += tryUnmerge(pair.worksheet, range) ? 1 : 0;
  }
  for (const range of candidates) {
    if (target.has(range)) changed += tryMerge(pair.worksheet, range) ? 1 : 0;
  }
  return changed;
}

/** 静默的合并/取消合并：exceljs 在"已经合并了"或"本来就没合"时会抛，这里当成功处理。 */
export function tryUnmerge(worksheet: Worksheet, range: string): boolean {
  try {
    worksheet.unMergeCells(range);
    return true;
  } catch {
    return false;
  }
}

export function tryMerge(worksheet: Worksheet, range: string): boolean {
  try {
    worksheet.mergeCells(range);
    return true;
  } catch {
    // 已经合并/与现有合并重叠：先拆再合，尽量让它落到"目标状态"
    tryUnmerge(worksheet, range);
    try {
      worksheet.mergeCells(range);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 把工作表里所有公式的 A1 引用按同一个操作改写。
 *
 * 为什么必须单独做：`spliceRows` 只搬格子（连批注都要我们自己搬），**不会改公式文本**——
 * 搬过去的 `B3*C3` 还是 `B3*C3`，而模型里已经算成 `B4*C4` 了。不改的话文件里就是错的引用。
 */
export function rewriteWorksheetFormulas(worksheet: Worksheet, edit: StructureEdit): void {
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = cell.value as { formula?: string } | null;
      if (!value || typeof value !== "object" || typeof value.formula !== "string") return;
      const original = `=${value.formula}`;
      const rewritten = shiftFormula(original, edit);
      if (rewritten !== original) cell.value = { ...value, formula: rewritten.slice(1) };
    });
  });
}
