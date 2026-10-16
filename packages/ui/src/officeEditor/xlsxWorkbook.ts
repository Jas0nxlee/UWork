/**
 * xlsx ↔ fortune-sheet 工作簿适配层。
 *
 * **写回不是"重新生成一份 xlsx"，而是在原字节上做差分**：保存时重新 load 源文件，
 * 只把"相对导入快照真的变了的那些格子/合并/列宽行高"写回去，再序列化。
 * 这么做的理由是保真：exceljs 读得懂、但我们不逐个映射的东西（批注、数据验证、超链接、
 * 定义名、打印设置、冻结窗格、网格线…）会**原样留在工作簿模型里**，只有被改动的格子才被重写。
 * 真会丢的（图表/透视表/宏/切片器/外部连接/条件格式）在护栏里就拦成只读了（xlsxPreflight）。
 *
 * 另一条硬约束：**导入时的快照（baseline）必须一起带着**。没有基线就分不出"用户改的"和
 * "适配器没映射的"，那时只能整表重写——那才是会丢东西的做法。
 */
import { Workbook } from "exceljs";
import type { Cell as ExcelCell, Worksheet } from "exceljs";
import type { Cell, Sheet, SheetConfig } from "@fortune-sheet/core";
import {
  addMerge,
  columnCharsToPx,
  columnPxToChars,
  rangeToRect,
  rectToRange,
  readCell,
  rowPtToPx,
  rowPxToPt,
  sameCell,
  writeCell,
} from "./xlsxMapping.js";

export interface XlsxReadResult {
  sheets: Sheet[];
  /** 活动工作表名（挂载时用它当活动表）。 */
  activeSheet?: string;
  warnings: string[];
}

/** fortune-sheet 网格的默认规模（小于它就铺满，免得表格看起来"只有几格）。 */
const MIN_ROWS = 60;
const MIN_COLUMNS = 20;

type Rect = { r: number; c: number; rs: number; cs: number };

function mergeAnchors(worksheet: Worksheet): Map<string, Rect> {
  const map = new Map<string, Rect>();
  for (const range of worksheet.model.merges ?? []) {
    const rect = rangeToRect(range);
    if (rect) map.set(`${rect.r}_${rect.c}`, rect);
  }
  return map;
}

function sheetConfigOf(worksheet: Worksheet, anchors: Map<string, Rect>): SheetConfig {
  const config: SheetConfig = {};
  const columnlen: Record<string, number> = {};
  for (const column of worksheet.columns ?? []) {
    if (column?.number && typeof column.width === "number") {
      columnlen[column.number - 1] = columnCharsToPx(column.width);
    }
  }
  if (Object.keys(columnlen).length > 0) config.columnlen = columnlen;

  const rowlen: Record<string, number> = {};
  const rows = worksheet.rowCount > 0 ? worksheet.getRows(1, worksheet.rowCount) : [];
  for (const row of rows ?? []) {
    if (row?.number && typeof row.height === "number") rowlen[row.number - 1] = rowPtToPx(row.height);
  }
  if (Object.keys(rowlen).length > 0) config.rowlen = rowlen;

  for (const rect of anchors.values()) addMerge(config, rect);
  return config;
}

/** 读一份 xlsx → fortune-sheet 的 Sheet[]（值 + 能表达的格式 + 合并/列宽行高/冻结/网格线）。 */
export async function readXlsxToSheets(bytes: ArrayBuffer): Promise<XlsxReadResult> {
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes);
  const warnings: string[] = [];
  const sheets: Sheet[] = [];
  // `<workbookView activeTab>` 是**零基的表序号**（exceljs 原样透传），不是 worksheet id
  const declaredActive = workbook.views?.[0]?.activeTab;
  let activeIndex = typeof declaredActive === "number" ? declaredActive : 0;

  workbook.eachSheet((worksheet, index) => {
    const anchors = mergeAnchors(worksheet);
    const celldata: Array<{ r: number; c: number; v: Cell }> = [];
    const hyperlink: Record<string, { linkType: string; linkAddress: string }> = {};
    let maxRow = 0;
    let maxColumn = 0;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (excelCell: ExcelCell, columnNumber: number) => {
        const read = readCell(excelCell);
        if (!read) return;
        const r = rowNumber - 1;
        const c = columnNumber - 1;
        const cell: Cell = { ...read.cell };
        const anchor = anchors.get(`${r}_${c}`);
        if (anchor) cell.mc = { r: anchor.r, c: anchor.c, rs: anchor.rs, cs: anchor.cs };
        if (read.hyperlink) hyperlink[`${r}_${c}`] = read.hyperlink;
        celldata.push({ r, c, v: cell });
        if (r > maxRow) maxRow = r;
        if (c > maxColumn) maxColumn = c;
      });
    });

    const view = worksheet.views?.[0];
    const frozen = view?.state === "frozen" && (view.xSplit || view.ySplit) ? view : undefined;
    const sheet: Sheet = {
      name: worksheet.name,
      order: sheets.length,
      status: index - 1 === activeIndex ? 1 : 0,
      celldata,
      config: sheetConfigOf(worksheet, anchors),
      row: Math.max(maxRow + 10, MIN_ROWS),
      column: Math.max(maxColumn + 3, MIN_COLUMNS),
      ...(worksheet.state === "visible" ? {} : { hide: 1 }),
      ...(Object.keys(hyperlink).length > 0 ? { hyperlink } : {}),
      ...(frozen
        ? {
            frozen: {
              type: frozen.xSplit && frozen.ySplit ? "both" : frozen.xSplit ? "column" : "row",
              range: { row_focus: frozen.ySplit ?? 0, column_focus: frozen.xSplit ?? 0 },
            },
          }
        : {}),
      ...(view?.showGridLines === false ? { showGridLines: false } : {}),
    };
    sheets.push(sheet);
    if (worksheet.state !== "visible") warnings.push(`工作表「${worksheet.name}」在源文件里是隐藏表`);
  });

  const active = sheets.find((sheet) => sheet.status === 1) ?? sheets[0];
  if (active) {
    for (const sheet of sheets) sheet.status = sheet === active ? 1 : 0;
  }
  return { sheets, activeSheet: active?.name, warnings };
}

/** 差分写回时一张表的三份来源：要写的那张 exceljs 表、导入快照、当前状态。 */
interface SheetPair {
  worksheet: Worksheet;
  baseline: Sheet | undefined;
  current: Sheet;
}

function cellMap(sheet: Sheet | undefined): Map<string, Cell> {
  const map = new Map<string, Cell>();
  for (const entry of sheet?.celldata ?? []) {
    if (entry.v) map.set(`${entry.r}_${entry.c}`, entry.v);
  }
  return map;
}

/** 单元格差分：只写"变了"的格子；被清空的格子写 null（删除操作才落得下去）。 */
function applyCellDiff(pair: SheetPair): number {
  const before = cellMap(pair.baseline);
  const after = cellMap(pair.current);
  let changed = 0;
  for (const [key, cell] of after) {
    if (sameCell(before.get(key), cell)) continue;
    const [r = 0, c = 0] = key.split("_").map(Number);
    writeCell(pair.worksheet.getCell(r + 1, c + 1), cell);
    changed += 1;
  }
  for (const key of before.keys()) {
    if (after.has(key)) continue;
    const [r = 0, c = 0] = key.split("_").map(Number);
    pair.worksheet.getCell(r + 1, c + 1).value = null;
    changed += 1;
  }
  return changed;
}

function mergeSet(sheet: Sheet | undefined): Set<string> {
  return new Set(Object.values(sheet?.config?.merge ?? {}).map((rect) => rectToRange(rect)));
}

function applyMergeDiff(pair: SheetPair): number {
  const before = mergeSet(pair.baseline);
  const after = mergeSet(pair.current);
  let changed = 0;
  for (const range of before) {
    if (after.has(range)) continue;
    try {
      pair.worksheet.unMergeCells(range);
      changed += 1;
    } catch {
      // 源表里没这条合并（基线被别的路径动过）：忽略即可
    }
  }
  for (const range of after) {
    if (before.has(range)) continue;
    pair.worksheet.mergeCells(range);
    changed += 1;
  }
  return changed;
}

function applySizeDiff(pair: SheetPair): number {
  let changed = 0;
  const beforeColumns = pair.baseline?.config?.columnlen ?? {};
  const afterColumns = pair.current.config?.columnlen ?? {};
  for (const [key, px] of Object.entries(afterColumns)) {
    if (beforeColumns[key] === px) continue;
    pair.worksheet.getColumn(Number(key) + 1).width = columnPxToChars(px);
    changed += 1;
  }
  const beforeRows = pair.baseline?.config?.rowlen ?? {};
  const afterRows = pair.current.config?.rowlen ?? {};
  for (const [key, px] of Object.entries(afterRows)) {
    if (beforeRows[key] === px) continue;
    pair.worksheet.getRow(Number(key) + 1).height = rowPxToPt(px);
    changed += 1;
  }
  return changed;
}

function applyViewDiff(pair: SheetPair): number {
  const view = pair.worksheet.views?.[0];
  if (!view) return 0;
  const wanted = pair.current.showGridLines === false ? false : true;
  if (view.showGridLines === wanted) return 0;
  view.showGridLines = wanted;
  return 1;
}

/**
 * 工作表配对：**先按名字配**（改了顺序也认得出来），剩下的再按位置配（处理"改名"）。
 * 为什么不能只按位置：用户在中间插入一张表，后面所有表的位置都会挪一位——按位置配会把
 * 每个表的基线错配成邻居的，差分就变成"把 B 表的内容整片改成 C 表的"。
 */
interface PendingPair {
  worksheet?: Worksheet;
  baseline: Sheet | undefined;
  current: Sheet;
}

function pairSheets(input: { source: Worksheet[]; baseline: Sheet[]; current: Sheet[] }): {
  /** **与 current 同下标对齐**（没有 worksheet 的位置就是要新建的表）。 */
  slots: PendingPair[];
  removed: Worksheet[];
} {
  const byName = new Map<string, Worksheet>();
  for (const worksheet of input.source) {
    if (!byName.has(worksheet.name)) byName.set(worksheet.name, worksheet);
  }
  const baselineByName = new Map<string, Sheet>();
  for (const sheet of input.baseline) {
    if (!baselineByName.has(sheet.name)) baselineByName.set(sheet.name, sheet);
  }

  const used = new Set<Worksheet>();
  const pending: PendingPair[] = input.current.map((sheet, index) => {
    const candidate = byName.get(sheet.name);
    const worksheet = candidate && !used.has(candidate) ? candidate : undefined;
    if (worksheet) used.add(worksheet);
    return {
      ...(worksheet ? { worksheet } : {}),
      baseline: baselineByName.get(sheet.name) ?? input.baseline[index],
      current: sheet,
    };
  });
  // 第二遍：没配上的按位置领（此刻还没被领走的位置就是"原地改了名"的那张）
  pending.forEach((pair, index) => {
    if (pair.worksheet) return;
    const candidate = input.source[index];
    if (candidate && !used.has(candidate)) {
      used.add(candidate);
      pair.worksheet = candidate;
    }
  });
  const removed = input.source.filter((worksheet) => !used.has(worksheet));
  return { slots: pending, removed };
}

function hasWorksheet(pair: PendingPair): pair is SheetPair {
  return pair.worksheet !== undefined;
}

export interface XlsxWriteResult {
  bytes: ArrayBuffer;
  /** 改了/写了多少处（0 表示没动过：调用方可以据此跳过一次写盘）。 */
  changedCells: number;
  notes: string[];
}

/**
 * 差分写回。`source` 是打开时的文件字节，`baseline` 是 `readXlsxToSheets` 的快照。
 * 表的新增/删除/改名/隐藏按工作表级别处理，其余一律"没变就不写"。
 */
export async function writeSheetsToXlsx(input: {
  source: ArrayBuffer;
  baseline: Sheet[];
  current: Sheet[];
}): Promise<XlsxWriteResult> {
  const workbook = new Workbook();
  await workbook.xlsx.load(input.source);
  const notes: string[] = [];
  const source = [...workbook.worksheets];
  // 槽位与 current 同下标对齐：这样"用户在中间插了一张表"也不会让后面的表拿错基线
  const { slots, removed } = pairSheets({
    source,
    baseline: input.baseline,
    current: input.current,
  });

  /** 工作表在文件里的顺序由 `orderNo` 决定（exceljs 的 `worksheets` getter 按它排序）。 */
  const ordered: Worksheet[] = [];
  let changedCells = 0;
  for (const pair of slots.filter(hasWorksheet)) {
    if (pair.worksheet.name !== pair.current.name) {
      const previous = pair.worksheet.name;
      pair.worksheet.name = pair.current.name;
      notes.push(`工作表改名：${previous} → ${pair.current.name}`);
    }
    if (Boolean(pair.worksheet.state && pair.worksheet.state !== "visible") !== Boolean(pair.current.hide)) {
      pair.worksheet.state = pair.current.hide ? "hidden" : "visible";
    }
    changedCells += applyCellDiff(pair);
    changedCells += applyMergeDiff(pair);
    changedCells += applySizeDiff(pair);
    changedCells += applyViewDiff(pair);
  }

  // 新增表 + 顺序：用户插入/拖动表之后，位置要跟着写回（OOXML 里的次序就是 <sheets> 的次序）
  for (const slot of slots) {
    const worksheet = slot.worksheet ?? workbook.addWorksheet(slot.current.name);
    if (!slot.worksheet) notes.push(`新增工作表：${slot.current.name}`);
    ordered.push(worksheet);
  }
  ordered.forEach((worksheet, index) => {
    const target = worksheet as Worksheet & { orderNo?: number };
    if (target.orderNo !== index) target.orderNo = index;
  });
  for (const worksheet of removed) {
    workbook.removeWorksheet(worksheet.id);
    notes.push(`删除工作表：${worksheet.name}`);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return { bytes: buffer as ArrayBuffer, changedCells, notes };
}
