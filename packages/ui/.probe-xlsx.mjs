import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCEL_PAGE, bundleExcelEntry } from "./scripts/lib/officeExcelPage.mjs";
import { startOfficeHarness } from "./scripts/lib/officeEditorHarness.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");
const harness = await startOfficeHarness({
  prefix: "probe-xlsx-",
  pages: { "index.html": EXCEL_PAGE },
  prepareDir: (dir) => bundleExcelEntry(dir, { repoRoot, editorDir, modules: ["xlsxWorkbook.ts"], sampleSheets: [] }),
  viewport: { width: 900, height: 700 },
});
const page = harness.page;
page.on("pageerror", (e) => process.stderr.write("pageerror " + e.message + "\n"));
await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60000 });
const out = await page.evaluate(async () => {
  const { bytes } = await window.__xlsx.fixture();
  const read = await window.__xlsx.read(bytes);
  const before = await window.__xlsx.parts(bytes);
  const sourceComments = bytes.byteLength;
  const edited = { ...read.sheets[0], celldata: read.sheets[0].celldata.map((e) => (e.r === 1 && e.c === 0 ? { ...e, v: { ...e.v, v: "香蕉", m: "香蕉" } } : e)) };
  const written = await window.__xlsx.write({ source: bytes, baseline: read.sheets, current: [edited, ...read.sheets.slice(1)] });
  const after = await window.__xlsx.parts(written.bytes);
  const zip = await window.JSZip.loadAsync(written.bytes);
  const zipBefore = await window.JSZip.loadAsync(bytes);
  const notes = {};
  const wb2 = new window.ExcelJS.Workbook();
  await wb2.xlsx.load(written.bytes);
  const sheet = wb2.getWorksheet("数据");
  notes.noteRaw = JSON.stringify(sheet?.getCell("A2").note ?? null).slice(0, 300);
  notes.commentXml = (await zip.file("xl/comments1.xml")?.async("string")) ?? "MISSING";
  notes.commentXmlBefore = (await zipBefore.file("xl/comments1.xml")?.async("string")) ?? "MISSING";
  const s1 = (await zip.file("xl/worksheets/sheet1.xml")?.async("string")) ?? "";
  const s1Before = (await zipBefore.file("xl/worksheets/sheet1.xml")?.async("string")) ?? "";
  notes.legacyDrawing = s1.includes("<legacyDrawing");
  notes.legacyDrawingBefore = s1Before.includes("<legacyDrawing");
  notes.relBefore = (await zipBefore.file("xl/worksheets/_rels/sheet1.xml.rels")?.async("string")) ?? "";
  notes.rel = (await zip.file("xl/worksheets/_rels/sheet1.xml.rels")?.async("string")) ?? "";
  notes.workbook = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  return { before, after, sourceComments, written: written.bytes.byteLength, changed: written.changedCells, notes };
});
process.stderr.write("noteRaw=" + out.notes.noteRaw + "\n");
process.stderr.write("legacyDrawing " + out.notes.legacyDrawingBefore + " -> " + out.notes.legacyDrawing + "\n");
process.stderr.write("comments before: " + out.notes.commentXmlBefore.slice(0, 400) + "\n\ncomments after: " + out.notes.commentXml.slice(0, 400) + "\n");
await harness.close();
