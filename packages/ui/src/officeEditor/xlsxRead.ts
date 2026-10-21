/**
 * xlsx → fortune-sheet 的**读侧**适配（写侧在 xlsxWorkbook.ts，结构操作在 xlsxStructureWrite.ts）。
 *
 * 拆出来的原因：仓库规矩单文件 ≤400 行，而读写合起来太长；这两侧本来也各自独立。
 */
import { Workbook } from "exceljs";
import type { Cell as ExcelCell, Worksheet } from "exceljs";
import type { Cell, Sheet, SheetConfig } from "@fortune-sheet/core";
import { addMerge, columnCharsToPx, rangeToRect, readCell, rowPtToPx } from "./xlsxMapping.js";

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
    if (row?.number && typeof row.height === "number")
      rowlen[row.number - 1] = rowPtToPx(row.height);
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
    if (worksheet.state !== "visible")
      warnings.push(`工作表「${worksheet.name}」在源文件里是隐藏表`);
  });

  const active = sheets.find((sheet) => sheet.status === 1) ?? sheets[0];
  if (active) {
    for (const sheet of sheets) sheet.status = sheet === active ? 1 : 0;
  }
  return { sheets, activeSheet: active?.name, warnings };
}
