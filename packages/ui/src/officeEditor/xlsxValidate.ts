/**
 * 保存前的**产物校验**（与 docx 的 docxValidate 同职责）。
 *
 * 为什么必须有：写回是"在原文件上做差分"，一旦适配层里有 bug（配对错、公式类型写坏、整表被覆盖），
 * 用户拿到的是**打不开或少了内容**的表格。宁可拒写并说清楚，也不能静默损坏文件——
 * 这是本仓库对 Office 文档的一贯口径（见 specs/office-editor-in-core.md）。
 *
 * 检查项都是"灾难级"的：文件能不能解析、表还在不在、非空单元格与公式的数量掉没掉一大截。
 * 不做逐格比对——用户本来就该改内容，逐格比对会把正常编辑误判成损坏。
 */
import { Workbook } from "exceljs";

export interface XlsxValidationIssue {
  kind: "invalid-xlsx" | "missing-sheet" | "cells-lost" | "formulas-lost";
  message: string;
}

export interface XlsxValidationResult {
  ok: boolean;
  issues: XlsxValidationIssue[];
  sheets: number;
  cells: number;
  formulas: number;
}

interface XlsxStats {
  sheets: string[];
  cells: number;
  formulas: number;
}

/** 统计一份工作簿的"内容量"（非空单元格数、公式数、表名）。 */
async function statsOf(bytes: ArrayBuffer): Promise<XlsxStats | null> {
  try {
    const workbook = new Workbook();
    await workbook.xlsx.load(bytes);
    const stats: XlsxStats = { sheets: [], cells: 0, formulas: 0 };
    workbook.eachSheet((worksheet) => {
      stats.sheets.push(worksheet.name);
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (cell.value === null || cell.value === undefined) return;
          stats.cells += 1;
          if (typeof cell.value === "object" && cell.value !== null && "formula" in cell.value) {
            stats.formulas += 1;
          }
        });
      });
    });
    return stats;
  } catch {
    return null;
  }
}

/** 内容量掉到源文件的这个比例以下就判为"丢内容"（正常编辑不会一次删掉 20% 的格子）。 */
const MIN_CONTENT_RATIO = 0.8;

export async function validateXlsxCandidate(
  candidate: ArrayBuffer,
  source?: ArrayBuffer | null,
): Promise<XlsxValidationResult> {
  const issues: XlsxValidationIssue[] = [];
  const stats = await statsOf(candidate);
  if (!stats) {
    return {
      ok: false,
      issues: [{ kind: "invalid-xlsx", message: "产物打不开（不是有效的 xlsx）" }],
      sheets: 0,
      cells: 0,
      formulas: 0,
    };
  }
  if (source) {
    const before = await statsOf(source);
    if (before) {
      for (const name of before.sheets) {
        if (!stats.sheets.includes(name)) {
          issues.push({ kind: "missing-sheet", message: `工作表「${name}」在产物里不见了` });
        }
      }
      if (stats.cells < before.cells * MIN_CONTENT_RATIO) {
        issues.push({
          kind: "cells-lost",
          message: `非空单元格从 ${before.cells} 掉到 ${stats.cells}`,
        });
      }
      if (before.formulas > 0 && stats.formulas < before.formulas * MIN_CONTENT_RATIO) {
        issues.push({
          kind: "formulas-lost",
          message: `公式从 ${before.formulas} 掉到 ${stats.formulas}`,
        });
      }
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    sheets: stats.sheets.length,
    cells: stats.cells,
    formulas: stats.formulas,
  };
}
