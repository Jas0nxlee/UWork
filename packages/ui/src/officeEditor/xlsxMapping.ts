/**
 * xlsx（exceljs）与 fortune-sheet 之间的**取值/格式映射**。
 *
 * 为什么要有这一层：两个模型对"一个单元格"的表示完全不同——exceljs 是 `cell.value` 的联合类型
 * （字符串/数字/Date/公式对象/富文本/超链接对象）加一堆 style 子对象，fortune-sheet 是扁平的
 * `{ v, m, f, ct, bl, it, fc, bg, ht, vt, tb … }`。这里只做**双向可逆的机械映射**：
 *   - 读：exceljs → fortune-sheet（值 + 能表达的那部分格式）；
 *   - 写：fortune-sheet → exceljs（只在单元格真的变了时才调用，见 xlsxWorkbook 的差分写回）。
 * 来回一趟不该丢东西，所以字段是成对写的，`sameCell` 也是按同一份投影比较。
 *
 * 没映射的东西**不假装**：主题色（theme color）、渐变填充、旋转文字、富文本分段样式在读的时候降级
 * （保留文字、丢掉分段样式），这些属于"护栏该不该拦"的问题，写在 specs/office-editors-triad.md。
 */
import type { Cell, SheetConfig } from "@fortune-sheet/core";
import type { Alignment, Cell as ExcelCell, Fill, Font } from "exceljs";

/** luckysheet 的水平对齐码：0=居中 1=左 2=右（垂直：0=居中 1=上 2=下）。 */
const H_ALIGN: Record<string, number> = { center: 0, left: 1, right: 2 };
const V_ALIGN: Record<string, number> = { middle: 0, top: 1, bottom: 2 };
const H_ALIGN_REVERSE: Array<Alignment["horizontal"]> = ["center", "left", "right"];
const V_ALIGN_REVERSE: Array<Alignment["vertical"]> = ["middle", "top", "bottom"];

/** exceljs 颜色（ARGB / 主题 / 索引）→ `#rrggbb`；说不清是什么颜色时返回 undefined（宁可不涂色）。 */
export function colorToHex(color: Partial<{ argb?: string }> | undefined): string | undefined {
  const argb = color?.argb;
  if (typeof argb !== "string" || argb.length < 6) return undefined;
  const rgb = argb.length >= 8 ? argb.slice(argb.length - 6) : argb;
  return `#${rgb.toLowerCase()}`;
}

function hexToColor(hex: string | undefined): { argb: string } | undefined {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return undefined;
  return { argb: `ff${hex.slice(1).toLowerCase()}` };
}

/**
 * 单元格格式（值以外的部分）。读与写用同一组字段，保证 `sameCell` 的比较口径与写回一致。
 */
export function readCellStyle(cell: ExcelCell): Cell {
  const style: Cell = {};
  const font: Partial<Font> = cell.font ?? {};
  if (font.bold) style.bl = 1;
  if (font.italic) style.it = 1;
  if (font.underline) style.un = 1;
  if (font.strike) style.cl = 1;
  if (font.name) style.ff = font.name;
  if (typeof font.size === "number") style.fs = font.size;
  const fontColor = colorToHex(font.color);
  if (fontColor) style.fc = fontColor;

  const fill: Partial<Fill> = cell.fill ?? {};
  if (fill.type === "pattern" && fill.pattern === "solid") {
    const background = colorToHex((fill as { fgColor?: { argb?: string } }).fgColor);
    if (background) style.bg = background;
  }

  const alignment: Partial<Alignment> = cell.alignment ?? {};
  const ht = alignment.horizontal ? H_ALIGN[alignment.horizontal] : undefined;
  if (ht !== undefined) style.ht = ht;
  const vt = alignment.vertical ? V_ALIGN[alignment.vertical] : undefined;
  if (vt !== undefined) style.vt = vt;
  if (alignment.wrapText) style.tb = "2";
  return style;
}

/** 富文本 → 纯文字（分段样式不映射，但**文字一个不丢**）。 */
function richTextToPlain(richText: Array<{ text?: string }> | undefined): string {
  return (richText ?? []).map((run) => run.text ?? "").join("");
}

function resultOf(value: { result?: unknown; error?: string }): string | number | boolean | undefined {
  if (value.error) return value.error;
  const result = value.result;
  if (result === null || result === undefined) return undefined;
  if (typeof result === "object") {
    const error = (result as { error?: string }).error;
    return error ?? undefined;
  }
  return result as string | number | boolean;
}

export interface ReadCellResult {
  cell: Cell;
  /** 单元格挂着的外部/内部链接（fortune-sheet 的写法是 sheet.hyperlink[`r_c`]）。 */
  hyperlink?: { linkType: string; linkAddress: string };
}

/**
 * exceljs 单元格 → fortune-sheet 单元格。
 * 返回 undefined 表示"这个格子在 fortune-sheet 里等于空"（没有值也没有格式）。
 */
export function readCell(cell: ExcelCell): ReadCellResult | undefined {
  const style = readCellStyle(cell);
  const hasStyle = Object.keys(style).length > 0;
  const value = cell.value as unknown;
  const numFmt = typeof cell.numFmt === "string" ? cell.numFmt : undefined;
  const format = numFmt && numFmt !== "General" ? numFmt : undefined;
  const withFormat = (extra: Cell): Cell => {
    const merged: Cell = { ...style, ...extra };
    // 数字格式：exceljs 报的是 "0.00"、"yyyy-mm-dd" 这类格式串，正好是 fortune-sheet 的 ct.fa
    if (format) merged.ct = { ...extra.ct, fa: format };
    return merged;
  };

  if (value === null || value === undefined) return hasStyle ? { cell: { ...style } } : undefined;
  if (typeof value === "string") {
    return { cell: withFormat({ v: value, m: value, ct: { t: "s" } }) };
  }
  if (typeof value === "number") {
    return { cell: withFormat({ v: value, m: value, ct: { t: "n" } }) };
  }
  if (typeof value === "boolean") {
    return { cell: withFormat({ v: value, m: value ? "TRUE" : "FALSE", ct: { t: "b" } }) };
  }
  if (value instanceof Date) {
    const iso = value.toISOString();
    return {
      cell: withFormat({ v: iso, m: iso.slice(0, 19).replace("T", " "), ct: { t: "d" } }),
    };
  }
  const object = value as {
    formula?: string;
    sharedFormula?: string;
    result?: unknown;
    error?: string;
    richText?: Array<{ text?: string }>;
    text?: string;
    hyperlink?: string;
  };
  if (object.formula || object.sharedFormula) {
    // **保留前导 "="**：引擎自己的公式（自动求和）就是带 "=" 存的，去掉 "=" 再让引擎算会得到 #NAME?
    // （实测：SUM(A1:A2) 不带 "=" → 重算后显示 #NAME?）。写回 exceljs 时再去掉，见 writeCell。
    const raw = object.formula ?? object.sharedFormula ?? "";
    const formula = raw.startsWith("=") ? raw : `=${raw}`;
    const result = resultOf(object);
    const text = result === undefined ? undefined : String(result);
    return { cell: withFormat({ f: formula, v: result, m: text }) };
  }
  if (object.richText) {
    const text = richTextToPlain(object.richText);
    return { cell: withFormat({ v: text, m: text, ct: { t: "s" } }) };
  }
  if (object.error) return { cell: withFormat({ v: object.error, m: object.error }) };
  if (typeof object.text === "string" || typeof object.hyperlink === "string") {
    const text = object.text ?? object.hyperlink ?? "";
    return {
      cell: withFormat({ v: text, m: text, ct: { t: "s" } }),
      ...(object.hyperlink
        ? {
            hyperlink: {
              linkType: /^[a-z]+:/i.test(object.hyperlink) ? "external" : "internal",
              linkAddress: object.hyperlink,
            },
          }
        : {}),
    };
  }
  return hasStyle ? { cell: { ...style } } : undefined;
}

/** 写回 exceljs：值 + 我们管的那些格式字段（保留这个格子上其它没动的字体/边框设置）。 */
export function writeCell(target: ExcelCell, cell: Cell): void {
  if (typeof cell.f === "string" && cell.f.length > 0) {
    const result = typeof cell.v === "number" || typeof cell.v === "boolean" ? cell.v : undefined;
    target.value = { formula: cell.f.replace(/^=/, ""), ...(result === undefined ? {} : { result }) };
  } else if (typeof cell.v === "string" && cell.ct?.t === "d") {
    const parsed = new Date(cell.v);
    target.value = Number.isNaN(parsed.getTime()) ? cell.v : parsed;
  } else if (
    cell.v === null ||
    cell.v === undefined ||
    typeof cell.v === "string" ||
    typeof cell.v === "number" ||
    typeof cell.v === "boolean"
  ) {
    target.value = (cell.v ?? null) as string | number | boolean | null;
  }

  if (cell.ct?.fa) target.numFmt = cell.ct.fa;

  const hasFontField =
    cell.bl !== undefined ||
    cell.it !== undefined ||
    cell.un !== undefined ||
    cell.cl !== undefined ||
    cell.ff !== undefined ||
    cell.fs !== undefined ||
    cell.fc !== undefined;
  if (hasFontField) {
    const color = hexToColor(cell.fc);
    target.font = {
      ...target.font,
      bold: cell.bl === 1,
      italic: cell.it === 1,
      underline: cell.un === 1,
      strike: cell.cl === 1,
      // null 表示"这一位被清掉了"（引擎清除格式写的就是 null）→ 从文件里也去掉
      name: typeof cell.ff === "string" ? cell.ff : undefined,
      size: typeof cell.fs === "number" ? cell.fs : undefined,
      // 颜色只有认得出来才改：主题色/索引色原样留着
      ...(color ? { color } : cell.fc === null ? { color: undefined } : {}),
    };
  }
  if (typeof cell.bg === "string" && /^#[0-9a-f]{6}$/i.test(cell.bg)) {
    target.fill = { type: "pattern", pattern: "solid", fgColor: hexToColor(cell.bg) };
  } else if (cell.bg === null) {
    target.fill = { type: "pattern", pattern: "none" };
  }
  const hasAlignField = cell.ht !== undefined || cell.vt !== undefined || cell.tb !== undefined;
  if (hasAlignField) {
    target.alignment = {
      ...target.alignment,
      ...(cell.ht !== undefined ? { horizontal: H_ALIGN_REVERSE[cell.ht] } : {}),
      ...(cell.vt !== undefined ? { vertical: V_ALIGN_REVERSE[cell.vt] } : {}),
      ...(cell.tb !== undefined ? { wrapText: cell.tb === "2" } : {}),
    };
  }
}

/** 参与"这个格子变没变"比较的字段（与 writeCell 管的字段一致）。 */
const COMPARED: Array<keyof Cell> = [
  "v",
  "m",
  "f",
  "bl",
  "it",
  "un",
  "cl",
  "ff",
  "fs",
  "fc",
  "bg",
  "ht",
  "vt",
  "tb",
];

export function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if ((a.ct?.fa ?? "") !== (b.ct?.fa ?? "")) return false;
  // null 与 undefined 视为同一件事：引擎"清除格式"写的是 null，而适配层没映射的字段是 undefined，
  // 不这样归一的话，清一次格式会把每个格子都误判成"改过"
  return COMPARED.every((key) => (a[key] ?? null) === (b[key] ?? null));
}

// —— 尺寸换算：fortune-sheet 用像素，exceljs 用"字符宽 / 磅" ——

/** Excel 列宽（字符）→ 像素：Calibri 11 下 `px ≈ width * 7 + 5`。 */
export function columnCharsToPx(chars: number): number {
  return Math.round(chars * 7 + 5);
}

export function columnPxToChars(px: number): number {
  return Math.max(0, Math.round(((px - 5) / 7) * 100) / 100);
}

/** 行高：exceljs 是磅（pt），fortune-sheet 是像素（96dpi）。 */
export function rowPtToPx(pt: number): number {
  return Math.round((pt * 4) / 3);
}

export function rowPxToPt(px: number): number {
  return Math.round(((px * 3) / 4) * 100) / 100;
}

export function columnLetter(index: number): string {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const rest = (value - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    value = Math.floor((value - rest - 1) / 26);
  }
  return letters;
}

export function columnIndexOf(letters: string): number {
  let value = 0;
  for (const char of letters.toUpperCase()) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return value - 1;
}

export function cellAddress(row: number, column: number): string {
  return `${columnLetter(column)}${row + 1}`;
}

/** "A1:C3" → { r, c, rs, cs }（零基、含端点）。 */
export function rangeToRect(range: string): { r: number; c: number; rs: number; cs: number } | null {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range.replace(/\$/g, ""));
  if (!match) return null;
  const [, firstColumn, firstRow, lastColumn, lastRow] = match;
  const r = Number(firstRow) - 1;
  const c = columnIndexOf(firstColumn ?? "A");
  const rs = Number(lastRow) - r;
  const cs = columnIndexOf(lastColumn ?? "A") - c + 1;
  return rs > 0 && cs > 0 ? { r, c, rs, cs } : null;
}

export function rectToRange(rect: { r: number; c: number; rs: number; cs: number }): string {
  return `${cellAddress(rect.r, rect.c)}:${cellAddress(rect.r + rect.rs - 1, rect.c + rect.cs - 1)}`;
}

/** 往 config.merge 里塞一条（fortune-sheet 的键是 `r_c`）。 */
export function addMerge(
  config: SheetConfig,
  rect: { r: number; c: number; rs: number; cs: number },
): void {
  config.merge = config.merge ?? {};
  config.merge[`${rect.r}_${rect.c}`] = rect;
}
