import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCEL_PAGE, bundleExcelEntry } from "./scripts/lib/officeExcelPage.mjs";
import { startOfficeHarness } from "./scripts/lib/officeEditorHarness.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");
const SAMPLE = [{ name: "表1", status: 1, row: 40, column: 12, celldata: [{ r: 0, c: 0, v: { v: 1 } }, { r: 1, c: 0, v: { v: 2 } }, { r: 4, c: 0, v: { f: "=SUM(A1:A3)", v: 6, m: "6" } }] }];
const harness = await startOfficeHarness({
  prefix: "probe-matrix-",
  pages: { "index.html": EXCEL_PAGE },
  prepareDir: (dir) => bundleExcelEntry(dir, { repoRoot, editorDir, modules: ["excelCommands.ts", "excelRibbonTabs.ts", "ribbonItemSupport.ts", "excelStructure.ts", "xlsxWorkbook.ts"], sampleSheets: SAMPLE }),
  viewport: { width: 1200, height: 800 },
});
const page = harness.page;
page.on("pageerror", (e) => process.stderr.write("PAGEERROR " + e.message.slice(0, 80) + "\n"));
await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60000 });
const out = await page.evaluate(async ([data]) => {
  await window.__excel.mount({ data });
  const api = () => window.__excel.api().current;
  const shape = () => {
    try {
      const sheet = api()?.getSheet?.() ?? api()?.getAllSheets()?.[0];
      return {
        rows: sheet?.data?.length,
        cols: sheet?.data?.[0]?.length,
        row: sheet?.row,
        column: sheet?.column,
        name: sheet?.name,
        selection: api()?.getSelectionCoordinates?.(),
      };
    } catch (error) {
      return { error: String(error).slice(0, 60) };
    }
  };
  const commands = [];
  for (const tab of window.app.EXCEL_RIBBON_TABS) {
    for (const group of tab.groups) {
      for (const item of group.items) {
        if (item.kind === "command") commands.push({ command: item.command, args: item.args ?? [] });
        if (item.kind === "select") {
          for (const option of item.options ?? []) commands.push({ command: window.app.optionsCommand(item.title), args: option.args });
        }
      }
    }
  }
  const log = [];
  for (const entry of commands) {
    let error = null;
    try {
      await window.__excel.run(entry.command, entry.args);
    } catch (thrown) {
      error = String(thrown).slice(0, 80);
    }
    const alive = api() != null;
    const state = alive ? shape() : null;
    log.push({ command: entry.command, alive, error, ...state });
    if (error || !alive) break;
  }
  return log.slice(-14);
}, [SAMPLE]);
process.stderr.write(JSON.stringify(out, null, 1) + "\n");
await harness.close();
