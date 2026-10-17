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
  applyStructureEdit,
  shiftFormula,
  transformIndex,
  type StructureEdit,
} from "./excelStructure.js";
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

/**
 * 把一张表摊成"非空格子"列表——**两种形状都要认**：
 *   - 导入快照（readXlsxToSheets 的产物）是 `celldata`；
 *   - 引擎（getAllSheets）把 celldata 转成 `data` 矩阵后**就把 celldata 删了**（initSheetData 里 delete），
 *     所以从编辑位拿到的表只有 `data`。
 * 只认 celldata 的后果很重：保存时会认为"所有格子都被删了"，要么写坏文件、要么被校验拦下永远存不了。
 */
/**
 * 引擎算过公式之后，会把**显示形态**（带样式 span 的 HTML）写回 `cell.f`
 * （实测：`<span …>=</span><span …>SUM</span>(<span …>B3:B4</span>)`）。
 * 直接拿去写文件就把 HTML 当公式写进去了——所以读引擎数据时统一还原成文本。
 */
function formulaText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.includes("<")) return value;
  const text = value
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
  return text.length > 0 ? text : undefined;
}

function normalizedCell(cell: Cell): Cell {
  const formula = formulaText(cell.f);
  if (formula === undefined || formula === cell.f) return cell;
  return { ...cell, f: formula };
}

export function cellEntries(sheet: Sheet | undefined): Array<{ r: number; c: number; cell: Cell }> {
  const entries: Array<{ r: number; c: number; cell: Cell }> = [];
  for (const entry of sheet?.celldata ?? []) {
    if (entry.v) entries.push({ r: entry.r, c: entry.c, cell: normalizedCell(entry.v) });
  }
  if (entries.length > 0) return entries;
  const matrix = sheet?.data;
  if (!matrix) return entries;
  matrix.forEach((row, r) => {
    row?.forEach((cell, c) => {
      if (cell) entries.push({ r, c, cell: normalizedCell(cell) });
    });
  });
  return entries;
}

function cellMap(sheet: Sheet | undefined): Map<string, Cell> {
  const map = new Map<string, Cell>();
  for (const entry of cellEntries(sheet)) {
    map.set(`${entry.r}_${entry.c}`, entry.cell);
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

/**
 * 表级显示设置（网格线 + 冻结窗格）。
 * 冻结在 fortune-sheet 里是 `sheet.frozen`，写回时要翻成 exceljs 的 `views[0]`（state/xSplit/ySplit），
 * 否则用户点了"冻结首行"、保存后再打开就没有了——那种"点了没反应"的观感是明确要避免的。
 */
function applyViewDiff(pair: SheetPair): number {
  const worksheet = pair.worksheet;
  const view = worksheet.views?.[0];
  if (!view) return 0;
  const wantedLines = pair.current.showGridLines === false ? false : true;
  const beforeFrozen = JSON.stringify(pair.baseline?.frozen ?? null);
  const afterFrozen = pair.current.frozen;
  const frozenChanged = beforeFrozen !== JSON.stringify(afterFrozen ?? null);
  if (view.showGridLines === wantedLines && !frozenChanged) return 0;

  const next = { ...view, showGridLines: wantedLines } as Record<string, unknown>;
  if (frozenChanged) {
    const xSplit = afterFrozen?.range?.column_focus ?? 0;
    const ySplit = afterFrozen?.range?.row_focus ?? 0;
    if ((xSplit || ySplit) && (afterFrozen?.type === "row" || afterFrozen?.type === "column" || afterFrozen?.type === "both")) {
      next.state = "frozen";
      next.xSplit = xSplit;
      next.ySplit = ySplit;
    } else {
      next.state = "normal";
      delete next.xSplit;
      delete next.ySplit;
    }
  }
  worksheet.views = [next as (typeof worksheet.views)[number]];
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

/**
 * 用户在编辑器里做过的**行列结构操作**（插入/删除）。
 *
 * 为什么要显式带进来、而不是让差分自己猜：插入一行时，值可以通过"差分写回"挪到新位置，
 * 但**挂在格子上的批注、行高、行级属性不会跟着走**（Excel 会把它们一起搬）。
 * 校验过：样例里的批注在插入行后会留在原来那格、内容却下去了——那是会误导人的。
 * 所以这里把操作用 exceljs 的 `spliceRows/spliceColumns` 落到文件上（它们搬整行/整列），
 * 同时把**基线也按同一个操作变换一次**，差分才只报"真的改了值"的那些格子。
 */
export interface StructureOp {
  sheetName: string;
  edit: StructureEdit;
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
/**
 * 把工作表里所有公式的 A1 引用按同一个操作改写。
 *
 * 为什么必须单独做：`spliceRows` 只搬格子（连批注一起），**不会改公式文本**——
 * 搬过去的 `B3*C3` 还是 `B3*C3`，而模型里已经算成 `B4*C4` 了。不改的话文件里就是错的引用。
 */
function rewriteWorksheetFormulas(worksheet: Worksheet, edit: StructureEdit): void {
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

/**
 * exceljs 的 `spliceRows/spliceColumns` 只搬**值、样式、行高**——批注与数据验证不会跟着走
 * （实测：插入一行后批注留在原地、内容却下去了，等于把批注标到了别的行上）。
 * 所以这里自己搬：先收起来 → 清掉 → 结构操作 → 按新位置写回。
 *
 * 清批注只能用内部字段：exceljs 没有"删批注"的公开 API，而 `cell.note = null` 会让写出直接抛
 * （`Cannot read properties of null (reading 'margins')`，实测）。字段名万一变了就退化成"批注不动"，
 * 不会写坏文件——所以这里带 `in` 判断。
 */
type WorksheetWithValidations = Worksheet & {
  dataValidations?: {
    model: Record<string, unknown>;
    add: (address: string, validation: unknown) => unknown;
  };
};

function moveDecorations(
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
    const start = transformIndex(Number(firstRow) - 1, isRow ? edit : { ...edit, index: 0, count: 0 });
    const startColumn = toIndex(firstColumn);
    const end = lastRow
      ? transformIndex(Number(lastRow) - 1, isRow ? edit : { ...edit, index: 0, count: 0 })
      : start;
    const endColumn = lastColumn ? toIndex(lastColumn) : startColumn;
    if (start === null || end === null) return null;
    const shiftedColumnStart = isRow ? startColumn : (transformIndex(startColumn, edit) ?? startColumn);
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
function applyStructureToWorksheet(
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

export async function writeSheetsToXlsx(input: {
  source: ArrayBuffer;
  baseline: Sheet[];
  current: Sheet[];
  /** 用户在编辑器里做过的行列结构操作（按顺序）。 */
  structureEdits?: StructureOp[];
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
    // 结构操作（插入/删除行列）先落到文件上：exceljs 的整行/整列搬移会**连批注、行高一起搬**，
    // 这是"差分写回"做不到的（差分只挪值）。基线同步做一次同样的变换，
    // 否则差分会把"搬过来的内容"看成"原来那格被删了"，反而清掉真数据。
    let baseline = pair.baseline;
    for (const op of (input.structureEdits ?? []).filter(
      (item) => item.sheetName === pair.current.name,
    )) {
      const columns = pair.current.column ?? pair.current.data?.[0]?.length ?? 26;
      const decorations = { notes: [], validations: [] } as Parameters<typeof moveDecorations>[3];
      moveDecorations(pair.worksheet as WorksheetWithValidations, op.edit, "collect", decorations);
      applyStructureToWorksheet(pair.worksheet, op.edit, columns);
      moveDecorations(pair.worksheet as WorksheetWithValidations, op.edit, "restore", decorations);
      rewriteWorksheetFormulas(pair.worksheet, op.edit);
      if (baseline) baseline = applyStructureEdit(baseline, cellEntries(baseline), op.edit).sheet;
      changedCells += 1;
    }
    const aligned: SheetPair = { worksheet: pair.worksheet, baseline, current: pair.current };
    // 顺序有意为之：**先合并/取消合并，再写格子**。exceljs 的 unMergeCells 会把从属格清空
    // （实测：先写进去的公式随后被 unmerge 抹掉，产物里公式凭空消失），所以格子必须最后写。
    changedCells += applyMergeDiff(aligned);
    changedCells += applyCellDiff(aligned);
    changedCells += applySizeDiff(aligned);
    changedCells += applyViewDiff(aligned);
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
