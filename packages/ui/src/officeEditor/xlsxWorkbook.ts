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
import type { Worksheet } from "exceljs";
import type { Cell, Sheet } from "@fortune-sheet/core";
import { applyStructureEdit, type StructureEdit } from "./excelStructure.js";
import { columnPxToChars, rectToRange, rowPxToPt, sameCell, writeCell } from "./xlsxMapping.js";
import {
  applyStructureToWorksheet,
  moveDecorations,
  rebuildMerges,
  rewriteWorksheetFormulas,
  type WorksheetWithValidations,
} from "./xlsxStructureWrite.js";

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

/** 差分写回时一张表的三份来源：要写的那张 exceljs 表、导入快照、当前状态。 */
interface SheetPair {
  worksheet: Worksheet;
  baseline: Sheet | undefined;
  current: Sheet;
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

/**
 * 结构操作之后的**合并重建**：先把可能与目标冲突的合并全拆掉，再按 `current` 建。
 *
 * 为什么不能沿用增量差分：`spliceRows/spliceColumns` 会重挂合并的从属格、但内部合并表的键不一定跟着走，
 * 于是"差分认为该新建、exceljs 认为已存在"，直接抛 `Cannot merge already merged cells`（实测）。
 * 结构操作是"整片搬家"，重建比增量更可预测。
 */
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
    if (
      (xSplit || ySplit) &&
      (afterFrozen?.type === "row" ||
        afterFrozen?.type === "column" ||
        afterFrozen?.type === "both")
    ) {
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
 * 但**挂在格子上的批注、行高、行级属性不会跟着走**（Excel 会把它们一起搬）。所以这里把操作
 * 用 exceljs 的 `spliceRows/spliceColumns` 落到文件上（它们搬整行/整列），
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
    if (
      Boolean(pair.worksheet.state && pair.worksheet.state !== "visible") !==
      Boolean(pair.current.hide)
    ) {
      pair.worksheet.state = pair.current.hide ? "hidden" : "visible";
    }
    // 结构操作（插入/删除行列）先落到文件上：exceljs 的整行/整列搬移会**连批注、行高一起搬**，
    // 这是"差分写回"做不到的（差分只挪值）。基线同步做一次同样的变换，
    // 否则差分会把"搬过来的内容"看成"原来那格被删了"，反而清掉真数据。
    let baseline = pair.baseline;
    let structural = false;
    const mergesBeforeStructural = [...(pair.worksheet.model.merges ?? [])];
    for (const op of (input.structureEdits ?? []).filter(
      (item) => item.sheetName === pair.current.name,
    )) {
      structural = true;
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
    changedCells += structural
      ? rebuildMerges(aligned, [...mergesBeforeStructural, ...(pair.worksheet.model.merges ?? [])])
      : applyMergeDiff(aligned);
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
