import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCEL_PAGE, bundleExcelEntry } from "./scripts/lib/officeExcelPage.mjs";
import { startOfficeHarness } from "./scripts/lib/officeEditorHarness.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");
const SAMPLE = [{
  name: "表1", status: 1, row: 40, column: 12,
  celldata: [
    { r: 0, c: 0, v: { v: 1 } }, { r: 1, c: 0, v: { v: 2 } }, { r: 2, c: 0, v: { f: "SUM(A1:A2)", v: 3, m: "3" } },
    { r: 0, c: 1, v: { v: "文字", bl: 1 } },
  ],
  config: { merge: { "4_1": { r: 4, c: 1, rs: 2, cs: 2 } }, columnlen: { 0: 120 }, rowlen: { 1: 30 } },
}];
const harness = await startOfficeHarness({
  prefix: "probe-struct-",
  pages: { "index.html": EXCEL_PAGE },
  prepareDir: (dir) => bundleExcelEntry(dir, { repoRoot, editorDir, modules: ["excelCommands.ts"], sampleSheets: SAMPLE }),
  viewport: { width: 1000, height: 700 },
});
const page = harness.page;
page.on("pageerror", (e) => process.stderr.write("PAGEERROR " + e.message + "\n"));
await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60000 });
const out = await page.evaluate(async ([data]) => {
  const log = [];
  const api = () => window.__excel.api().current;
  await window.__excel.mount({ data });
  // 1) setSelection 到底行不行（之前只用 getSelection 读过，那个 API 本身是坏的）
  api().setSelection([{ row: [1, 1], column: [1, 1] }]);
  await new Promise((r) => requestAnimationFrame(r));
  log.push({ step: "setSelection", coordinates: api().getSelectionCoordinates(), selection: api().getSelection() });
  // 2) 自己算好新表 → updateSheet（带 data 矩阵，走"整表替换"那条路）
  const sheet = api().getAllSheets()[0];
  log.push({
    step: "getAllSheets 形状",
    keys: Object.keys(sheet).sort(),
    hasData: Array.isArray(sheet.data),
    dataRows: sheet.data?.length,
    dataCols: sheet.data?.[0]?.length,
    hasCelldata: Array.isArray(sheet.celldata),
    row: sheet.row,
    column: sheet.column,
    sample: JSON.stringify(sheet.data?.[1]?.[0] ?? null).slice(0, 80),
  });
  const celldata = [];
  (sheet.data ?? []).forEach((row, r) => row?.forEach((cell, c) => { if (cell) celldata.push({ r, c, v: cell }); }));
  const shifted = celldata.map((e) => (e.r >= 1 ? { ...e, r: e.r + 1 } : e));
  shifted.push({ r: 1, c: 0, v: { v: "新插入" } });
  const rows = sheet.row + 1, cols = sheet.column;
  const matrix = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
  for (const e of shifted) matrix[e.r][e.c] = e.v;
  const next = { ...sheet, data: matrix, row: rows, celldata: undefined };
  api().updateSheet([next]);
  await new Promise((r) => setTimeout(r, 250));
  log.push({
    step: "updateSheet 插入行",
    alive: api() != null,
    a1: api()?.getCellValue(0, 0, { type: "v" }),
    a2: api()?.getCellValue(1, 0, { type: "v" }),
    a3: api()?.getCellValue(2, 0, { type: "v" }),
    a4formula: String(api()?.getCellValue(3, 0, { type: "f" }) ?? "").replace(/<[^>]+>/g, ""),
    b1bold: api()?.getCellValue(0, 1, { type: "bl" }),
    dataRows: api()?.getAllSheets()[0].data?.length,
  });
  // 3) 替换之后引擎还健康吗（写格式、再 updateSheet 一次）
  api().setCellFormatByRange("it", 1, [{ row: [0, 0], column: [1, 1] }]);
  await new Promise((r) => requestAnimationFrame(r));
  log.push({ step: "替换后写格式", alive: api() != null, italic: api()?.getCellValue(0, 1, { type: "it" }) });
  api().calculateFormula();
  await new Promise((r) => requestAnimationFrame(r));
  log.push({ step: "替换后算公式", alive: api() != null, a4: String(api()?.getCellValue(3, 0, { type: "m" }) ?? "") });
  return log;
}, [SAMPLE]);
process.stderr.write(JSON.stringify(out, null, 1) + "\n");
await harness.close();
