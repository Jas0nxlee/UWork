import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCEL_PAGE, bundleExcelEntry } from "./scripts/lib/officeExcelPage.mjs";
import { startOfficeHarness } from "./scripts/lib/officeEditorHarness.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");
const log = (m) => process.stderr.write(m + "\n");
const harness = await startOfficeHarness({
  prefix: "probe-type-",
  pages: { "index.html": EXCEL_PAGE },
  prepareDir: (dir) => bundleExcelEntry(dir, { repoRoot, editorDir, modules: [], sampleSheets: [{ name: "报表", celldata: [{ r: 0, c: 0, v: { v: "编号" } }, { r: 1, c: 0, v: { v: "第二行" } }] }] }),
  viewport: { width: 1000, height: 700 },
});
const page = harness.page;
page.on("pageerror", (e) => log("pageerror " + e.message));
await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60000 });
await page.evaluate(() => window.__excel.mount({}));
await page.waitForSelector("#host canvas");
const box = await page.locator("#host canvas").first().boundingBox();
log("canvas box " + JSON.stringify(box));
await page.mouse.click(Math.round(box.x + 200), Math.round(box.y + 60));
await page.waitForTimeout(200);
log("after click: " + JSON.stringify(await page.evaluate(() => ({
  address: window.__excel.api().current.getSelectionCoordinates()[0],
  active: document.activeElement?.tagName + ":" + (document.activeElement?.id || document.activeElement?.className || ""),
  inputs: Array.from(document.querySelectorAll("input,textarea")).map((n) => n.id + "/" + n.className),
}))));
// 1) ASCII 输入
await page.keyboard.type("ABC");
await page.waitForTimeout(300);
log("after type ABC: " + JSON.stringify(await page.evaluate(() => ({
  address: window.__excel.api().current.getSelectionCoordinates()[0],
  value: window.__excel.cell(1, 0, "v"),
  counts: window.__excel.counts(),
  active: document.activeElement?.tagName + ":" + (document.activeElement?.id || ""),
  inputs: Array.from(document.querySelectorAll("input,textarea")).map((n) => n.id + "/" + n.value),
}))));
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
log("after Enter: " + JSON.stringify(await page.evaluate(() => ({
  value: window.__excel.cell(1, 0, "v"),
  counts: window.__excel.counts(),
  inputs: Array.from(document.querySelectorAll("input,textarea")).map((n) => n.id + "/" + n.value),
}))));
// 2) 中文输入（insertText）
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.keyboard.insertText("中文");
await page.waitForTimeout(300);
log("after insertText: " + JSON.stringify(await page.evaluate(() => ({
  address: window.__excel.api().current.getSelectionCoordinates()[0],
  values: [window.__excel.cell(2, 0, "v"), window.__excel.cell(1, 0, "v")],
  counts: window.__excel.counts(),
}))));
await harness.close();
