/**
 * 表格的**结构化编辑**（插入/删除行列）—— 自己算，不走引擎的那两个 API。
 *
 * 为什么不走引擎：`insertRowOrColumn` / `deleteRowOrColumn` 会把表状态弄坏
 * （实测：之后 `sheet.data` 变成 0 行，下一次列操作读 `d[0].length` 直接崩、整个编辑区白屏）。
 * 但引擎给了另一条**安全**的路：`updateSheet([sheet])` 带 `data` 矩阵时是"整表替换"，
 * 替换后引擎依然健康（实测：还能写格式、还能重算公式）。所以这里做纯函数变换，算完一次交回去。
 *
 * 变换要跟着动的**不只是格子**（只动格子会留下错位的合并/行高/公式，那是最难发现的一类错）：
 * 值、合并区域、行高列宽、隐藏行列、冻结位置、以及**公式里的 A1 引用**。
 * 这也是"旧路走不通就走纯函数"的收益：每一步都能被单元级断言盯住（见 check-office-excel-ui.mjs）。
 */
import type { Cell, Sheet, SheetConfig } from "@fortune-sheet/core";
import { columnIndexOf, columnLetter } from "./xlsxMapping.js";

export type StructureKind = "row" | "column";

export interface StructureEdit {
  kind: StructureKind;
  /** "insert"：在 index 之前插入 count 条；"delete"：删除 [index, index+count-1]。 */
  mode: "insert" | "delete";
  index: number;
  count: number;
}

export interface CellEntry {
  r: number;
  c: number;
  cell: Cell;
}

/** 行列索引的变换：老索引 → 新索引（null 表示这一行/列被删掉了）。 */
export function transformIndex(index: number, edit: StructureEdit): number | null {
  if (edit.mode === "insert") return index >= edit.index ? index + edit.count : index;
  if (index < edit.index) return index;
  if (index < edit.index + edit.count) return null;
  return index - edit.count;
}

const IDENTIFIER = /[A-Za-z0-9_\u4e00-\u9fa5.]/;

/**
 * 改写公式里的 A1 引用（插入/删除行列后，Excel 也是这么干的）。
 *
 * 刻意保守，三处防误伤（都是实测会踩的）：
 *   - 只改写**不带工作表前缀**的引用（`'表 1'!A1` 这种跨表引用原样留着——我们不知道它指向哪张表，
 *     猜错比不改更糟）；
 *   - 跳过字符串字面量；
 *   - 函数名不算引用（`LOG10(A1)` 里的 `LOG10` 长得就像"LOG 列第 10 行"），
 *     所以匹配后面紧跟 `(` 的一律当函数名；前面紧跟标识符字符的也不当引用（挡住 `1E5`、`MyRange1`）。
 */
export function shiftFormula(formula: string, edit: StructureEdit): string {
  const isRow = edit.kind === "row";
  const pattern =
    /^(?:'[^']*'!|[A-Za-z\u4e00-\u9fa5_][\w\u4e00-\u9fa5.]*!)?(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/;
  let result = "";
  let index = 0;
  let inString = false;
  while (index < formula.length) {
    const char = formula[index] ?? "";
    if (char === '"') {
      inString = !inString;
      result += char;
      index += 1;
      continue;
    }
    if (inString) {
      result += char;
      index += 1;
      continue;
    }
    const previous = index > 0 ? (formula[index - 1] ?? "") : "";
    const match = previous && IDENTIFIER.test(previous) ? null : pattern.exec(formula.slice(index));
    if (match) {
      const [text, columnDollar = "", columnText = "", rowDollar = "", rowText = ""] = match;
      const isFunctionCall = formula[index + text.length] === "(";
      const target = isRow ? Number(rowText) - 1 : columnIndexOf(columnText);
      if (!text.includes("!") && !isFunctionCall && Number.isFinite(target)) {
        const shifted = transformIndex(target, edit);
        if (shifted === null) {
          // 引用被删掉了：Excel 的写法是 #REF!
          result += `${columnDollar}${columnText}${rowDollar}#REF!`;
          index += text.length;
          continue;
        }
        if (shifted !== target) {
          result += isRow
            ? `${columnDollar}${columnText}${rowDollar}${shifted + 1}`
            : `${columnDollar}${columnLetter(shifted)}${rowDollar}${rowText}`;
          index += text.length;
          continue;
        }
      }
      result += text;
      index += text.length;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

/** 合并区域的键（锚点 r_c）。 */
function mergeKey(rect: { r: number; c: number }): string {
  return `${rect.r}_${rect.c}`;
}

/** 合并区域：改动点之前不变、之后整体平移、跨越改动点的收缩、被完全覆盖的丢掉。 */
function transformMerges(config: SheetConfig | undefined, edit: StructureEdit): SheetConfig["merge"] {
  const merges = config?.merge;
  if (!merges) return undefined;
  const next: NonNullable<SheetConfig["merge"]> = {};
  for (const rect of Object.values(merges)) {
    const start = edit.kind === "row" ? rect.r : rect.c;
    const size = edit.kind === "row" ? rect.rs : rect.cs;
    const end = start + size - 1;
    const shaped = (newStart: number, newSize: number) =>
      edit.kind === "row"
        ? { r: newStart, c: rect.c, rs: newSize, cs: rect.cs }
        : { r: rect.r, c: newStart, rs: rect.rs, cs: newSize };

    if (edit.mode === "insert") {
      const shifted = transformIndex(start, edit) ?? start;
      const moved = shaped(shifted, size);
      next[mergeKey(moved)] = moved;
      continue;
    }
    const removeEnd = edit.index + edit.count - 1;
    if (end < edit.index) {
      next[mergeKey(rect)] = rect;
      continue;
    }
    if (start > removeEnd) {
      const moved = shaped(start - edit.count, size);
      next[mergeKey(moved)] = moved;
      continue;
    }
    const overlap = Math.min(end, removeEnd) - Math.max(start, edit.index) + 1;
    const remaining = size - overlap;
    if (remaining <= 0) continue;
    const moved = shaped(start < edit.index ? start : edit.index, remaining);
    next[mergeKey(moved)] = moved;
  }
  return next;
}

/** 行高/列宽/隐藏这类"带索引的映射"：删掉的丢、后面的平移。 */
function transformIndexMap(
  map: Record<string, number> | undefined,
  edit: StructureEdit,
): Record<string, number> | undefined {
  if (!map) return map;
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(map)) {
    const shifted = transformIndex(Number(key), edit);
    if (shifted === null) continue;
    next[String(shifted)] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** 冻结位置：改动点在冻结区之前时跟着挪，否则不动。 */
function transformFrozen(sheet: Sheet, edit: StructureEdit): Sheet["frozen"] {
  const frozen = sheet.frozen;
  if (!frozen?.range) return frozen;
  const isRow = edit.kind === "row";
  const focus = isRow ? frozen.range.row_focus : frozen.range.column_focus;
  const shifted = transformIndex(focus, edit);
  if (shifted === null || shifted === focus) return frozen;
  return {
    ...frozen,
    range: {
      row_focus: isRow ? shifted : frozen.range.row_focus,
      column_focus: isRow ? frozen.range.column_focus : shifted,
    },
  };
}

/** 把 entries 攒成 `data` 矩阵（引擎 updateSheet 要的形状）。 */
export function buildMatrix(
  entries: CellEntry[],
  rows: number,
  columns: number,
): Array<Array<Cell | null>> {
  const matrix: Array<Array<Cell | null>> = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => null),
  );
  for (const entry of entries) {
    if (entry.r < 0 || entry.r >= rows || entry.c < 0 || entry.c >= columns) continue;
    const row = matrix[entry.r];
    if (row) row[entry.c] = entry.cell;
  }
  return matrix;
}

export interface StructureResult {
  sheet: Sheet;
  /** 受影响区域，用于把选区放到"用户会想要的位置"。 */
  focus: { row: number; column: number };
  /** 被移动/重建的格子数（交代给用户看）。 */
  movedCells: number;
}

/**
 * 对一张表做一次插入/删除（行列皆可），返回可直接交给 `updateSheet` 的新表。
 *
 * `entries` 用 `xlsxWorkbook.cellEntries()` 拿（它同时认 `celldata` 与引擎的 `data` 矩阵）。
 */
export function applyStructureEdit(
  sheet: Sheet,
  entries: CellEntry[],
  edit: StructureEdit,
): StructureResult {
  const isRow = edit.kind === "row";
  const usedRows = entries.reduce((max, entry) => Math.max(max, entry.r + 1), 0);
  const usedColumns = entries.reduce((max, entry) => Math.max(max, entry.c + 1), 0);
  const columns = Math.max(sheet.column ?? 0, usedColumns);
  const rows = Math.max(sheet.row ?? 0, usedRows);
  const nextRows = isRow
    ? edit.mode === "insert"
      ? rows + edit.count
      : Math.max(1, rows - edit.count)
    : rows;
  const nextColumns = isRow
    ? columns
    : edit.mode === "insert"
      ? columns + edit.count
      : Math.max(1, columns - edit.count);

  const moved: CellEntry[] = [];
  for (const entry of entries) {
    const target = transformIndex(isRow ? entry.r : entry.c, edit);
    if (target === null) continue;
    const cell: Cell = { ...entry.cell };
    if (typeof cell.f === "string") {
      const rewritten = shiftFormula(cell.f, edit);
      if (rewritten !== cell.f) cell.f = rewritten;
    }
    moved.push({ r: isRow ? target : entry.r, c: isRow ? entry.c : target, cell });
  }

  const config: SheetConfig = {
    ...sheet.config,
    merge: transformMerges(sheet.config, edit),
  };
  if (isRow) {
    config.rowlen = transformIndexMap(sheet.config?.rowlen, edit);
    config.rowhidden = transformIndexMap(sheet.config?.rowhidden, edit);
  } else {
    config.columnlen = transformIndexMap(sheet.config?.columnlen, edit);
    config.colhidden = transformIndexMap(sheet.config?.colhidden, edit);
  }

  // 锚点上的 mc 按新 config 重算：避免"锚点说合并了、config 里没有"这种错位
  for (const entry of moved) {
    const anchor = config.merge?.[mergeKey(entry)];
    if (anchor) entry.cell.mc = { r: anchor.r, c: anchor.c, rs: anchor.rs, cs: anchor.cs };
    else if (entry.cell.mc) delete entry.cell.mc;
  }

  const nextSheet: Sheet = {
    ...sheet,
    row: nextRows,
    column: nextColumns,
    config,
    // 引擎的 updateSheet 见到 data 走"整表替换"、见到 celldata 只重建矩阵——这里给 data，
    // 并把 celldata 清掉（否则引擎会把过期的 celldata 当成真相）
    data: buildMatrix(moved, nextRows, nextColumns),
    celldata: undefined,
    frozen: transformFrozen(sheet, edit),
  };
  return {
    sheet: nextSheet,
    focus: isRow ? { row: edit.index, column: 0 } : { row: 0, column: edit.index },
    movedCells: moved.length,
  };
}
