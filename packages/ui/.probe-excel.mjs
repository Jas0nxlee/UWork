import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCEL_PAGE, bundleExcelEntry } from "./scripts/lib/officeExcelPage.mjs";
import { startOfficeHarness } from "./scripts/lib/officeEditorHarness.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");
const log = (m) => process.stderr.write(`[${Date.now() % 100000}] ${m}\n`);
log("start");
const harness = await startOfficeHarness({
  prefix: "probe-excel-",
  pages: { "index.html": EXCEL_PAGE },
  prepareDir: async (dir) => {
    log("bundle begin");
    await bundleExcelEntry(dir, { repoRoot, editorDir, modules: [], sampleSheets: [{ name: "S", celldata: [{ r: 0, c: 0, v: { v: "x" } }] }] });
    log("bundle done");
  },
  viewport: { width: 1000, height: 700 },
});
log("harness up");
const page = harness.page;
page.on("pageerror", (e) => log("pageerror " + e.message));
await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60000 });
log("ready");
await page.evaluate(() => window.__excel.mount({}));
log("mounted");
await page.waitForSelector("#host canvas", { timeout: 20000 });
log("canvas count " + (await page.locator("#host canvas").count()));
const a1 = await page.evaluate(() => window.__excel.cell(0, 0, "v"));
log("a1=" + JSON.stringify(a1));
await harness.close();
log("closed");
