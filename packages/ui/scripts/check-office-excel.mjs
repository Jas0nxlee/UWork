/**
 * Excel 编辑位的**引擎回归**：fortune-sheet 在 React 19 + 浏览器打包下是否可用，
 * 以及只读拦截、公式计算、I/O 依赖（exceljs）是否成立。
 *
 * 为什么先有这一条：Word 那边的教训是"引擎参数不对会静默失效"（纸张传字符串、控件只给 type、
 * 连页枚举写错）。fortune-sheet 的 allowEdit 与 API 也一样——documented 的东西不代表真的生效，
 * 所以这里先把它按真机用法跑一遍：能挂载、能改、**只读时改不动**（而且非只读时同样的动作必须改得动，
 * 否则这条断言是空的）、公式算得出来、exceljs 能在浏览器里读写。
 *
 * 用法：node packages/ui/scripts/check-office-excel.mjs
 * 依赖：仓库已装的 esbuild + playwright-core + 无头 Chromium（OFFICE_CHECK_CHROMIUM）。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCEL_PAGE, bundleExcelEntry } from "./lib/officeExcelPage.mjs";
import { startOfficeHarness } from "./lib/officeEditorHarness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");

/** 挂载用的样例表：A1 文字、B1/C1 数字、D1 求和公式、一处合并、一处底色。 */
const SAMPLE_SHEETS = [
  {
    name: "报表",
    celldata: [
      { r: 0, c: 0, v: { v: "编号", bl: 1 } },
      { r: 0, c: 1, v: { v: 2, bg: "#fff2cc" } },
      { r: 0, c: 2, v: { v: 3 } },
      { r: 0, c: 3, v: { f: "=SUM(B1:C1)", v: 5, m: "5" } },
      { r: 1, c: 0, v: { v: "第二行" } },
    ],
    config: { merge: { "3_4": { r: 3, c: 4, rs: 1, cs: 2 } }, columnlen: { 0: 120 } },
    row: 30,
    column: 12,
  },
];

async function main() {
  // 打产物（fortune-sheet + exceljs + React 合起来是个大包）——卡住时能看出卡在哪一步
  const started = Date.now();
  const stage = (name) => console.log(`… ${name}（${Math.round((Date.now() - started) / 1000)}s）`);
  stage("打产物");
  const harness = await startOfficeHarness({
    prefix: "office-excel-",
    pages: { "index.html": EXCEL_PAGE },
    prepareDir: (dir) =>
      bundleExcelEntry(dir, {
        repoRoot,
        editorDir,
        modules: [],
        sampleSheets: SAMPLE_SHEETS,
      }),
    viewport: { width: 1200, height: 800 },
  });
  stage("页面就绪");
  const page = harness.page;

  const failures = [];
  const check = (ok, message) => {
    if (ok) console.log(`ok   ${message}`);
    else {
      console.log(`FAIL ${message}`);
      failures.push(message);
    }
  };

  await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 20000 });

  // ① React 19 挂载：fortune-sheet 的 peer 写的是 react >= 18.2，19 上到底行不行要看真跑
  await page.evaluate(() => window.__excel.mount({}));
  await page.waitForSelector("#host canvas", { timeout: 15000 });
  const canvasCount = await page.locator("#host canvas").count();
  check(canvasCount > 0, `React 19 下挂载出画布（${canvasCount} 块）`);

  const mounted = await page.evaluate(() => ({
    sheets: window.__excel.sheets().map((sheet) => sheet.name),
    a1: window.__excel.cell(0, 0, "v"),
    d1: window.__excel.cell(0, 3, "m"),
  }));
  check(mounted.sheets.join(",") === "报表", `工作表名读回（${mounted.sheets.join(",")}）`);
  check(mounted.a1 === "编号", `初始单元格值读回（A1=${JSON.stringify(mounted.a1)}）`);
  check(mounted.d1 === "5", `初始公式结果显示（D1=${JSON.stringify(mounted.d1)}）`);

  // ② API 写入 → 读回（功能区走的就是这套 API）。
  // fortune-sheet 的 API 是 dispatch 到 React store，**同一 tick 里读回来还是旧值**，所以等一帧。
  const apiWrite = await page.evaluate(async () => {
    const api = window.__excel.api().current;
    api.setCellValue(1, 1, "写入测试");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return window.__excel.cell(1, 1, "v");
  });
  check(apiWrite === "写入测试", `WorkbookInstance API 能写入（B2=${JSON.stringify(apiWrite)}）`);

  // ③ 公式：设 f 后 calculateFormula，m 要是算出来的值
  const formula = await page.evaluate(async () => {
    const api = window.__excel.api().current;
    api.setCellValue(2, 1, 4);
    api.setCellValue(2, 2, 5);
    api.setCellFormat(2, 3, "f", "=SUM(B3:C3)");
    api.calculateFormula();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { m: window.__excel.cell(2, 3, "m"), v: window.__excel.cell(2, 3, "v") };
  });
  check(
    String(formula.m) === "9" || String(formula.v) === "9",
    `公式能算（SUM(B3:C3)=${JSON.stringify(formula.m ?? formula.v)}）`,
  );

  // ④ 界面编辑（正对照）：点进网格 → 用方向键走到目标格 → 输入 → 回车，值必须变。
  // 为什么用方向键而不是按坐标点：canvas 里"点到第几格"要靠表头/列宽/行高算，算错就变成
  // 点进了别的格子——那样"改不动"的断言会**假通过**。走到哪一格由引擎自己回话（选区地址）。
  const address = () => page.evaluate(() => window.__excel.api().current.getSelectionCoordinates()[0]);
  const colOf = (address) => address.replace(/\d+/g, "");
  const rowOf = (address) => Number(address.replace(/\D+/g, ""));
  const gridBox = await page.locator("#host canvas").first().boundingBox();
  // 只要落在网格里（避开行头/列头）就行：具体哪一格由选区地址回话
  const gridPoint = { x: Math.round(gridBox.x + 200), y: Math.round(gridBox.y + 60) };
  const selectCell = async (target) => {
    await page.mouse.click(gridPoint.x, gridPoint.y);
    for (let step = 0; step < 60; step += 1) {
      const current = await address();
      if (current === target) return true;
      const currentColumn = colOf(current);
      const targetColumn = colOf(target);
      if (currentColumn !== targetColumn) {
        await page.keyboard.press(currentColumn < targetColumn ? "ArrowRight" : "ArrowLeft");
      } else {
        await page.keyboard.press(rowOf(current) < rowOf(target) ? "ArrowDown" : "ArrowUp");
      }
      await page.waitForTimeout(20);
    }
    return false;
  };

  await page.evaluate(() => window.__excel.mount({}));
  await page.waitForSelector("#host canvas");
  const reached = await selectCell("B2");
  check(reached, `方向键能把选区走到目标格（${await address()}）`);
  // 用半角字母：无头环境里 IME 中文是另一条通路（composition 事件），
  // 这里要验的是"键入 → 落格"这条主路，中文入格由 API 断言覆盖。
  await page.keyboard.type("edited");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const editedValue = await page.evaluate(() => window.__excel.cell(1, 1, "v"));
  const counts = await page.evaluate(() => window.__excel.counts());
  check(editedValue === "edited", `可编辑时界面输入生效（B2=${JSON.stringify(editedValue)}）`);
  check(
    counts.changes > 0 && counts.ops > 0,
    `可编辑时 onChange/onOp 有回调（changes=${counts.changes}, ops=${counts.ops}）`,
  );

  // ⑤ 只读：allowEdit=false 时同样的动作必须**改不动**（护栏拒写/只读预览都靠它）。
  // 目标是 A2（原有文字"第二行"）：空→空说明不了问题，有内容才能看出"没被覆盖"。
  await page.evaluate(() => window.__excel.mount({ allowEdit: false }));
  await page.waitForSelector("#host canvas");
  const reachedReadOnly = await selectCell("A2");
  const opsBefore = (await page.evaluate(() => window.__excel.counts())).ops;
  await page.keyboard.type("blocked");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const readOnly = await page.evaluate(() => ({
    value: window.__excel.cell(1, 0, "v"),
    ops: window.__excel.counts().ops,
  }));
  check(
    reachedReadOnly && readOnly.value === "第二行" && readOnly.ops === opsBefore,
    `allowEdit=false 时界面输入被拦（A2=${JSON.stringify(readOnly.value)}，写入 op=${readOnly.ops - opsBefore} 条）`,
  );

  // ⑥ exceljs 在浏览器里的读写（xlsx 适配层的唯一依赖）
  const roundTrip = await page.evaluate(() => window.__excel.excelRoundTrip());
  check(
    roundTrip.a1 === "hello" && roundTrip.c1Formula === "B1*2",
    `exceljs 浏览器读写可用（${roundTrip.bytes} 字节，C1 公式=${JSON.stringify(roundTrip.c1Formula)}）`,
  );

  await harness.close();
  if (failures.length > 0) {
    console.log(`\n${failures.length} 条未通过`);
    process.exitCode = 1;
  } else {
    console.log("\nExcel 引擎检查全部通过");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
