/**
 * Excel 编辑位的**功能区/命令回归**：把功能区的每一条命令都真的跑一遍，并验证它落到表格上。
 *
 * 三条底线（与 Word 那边同款）：
 *   ① **命令矩阵**：EXCEL_RIBBON_TABS 里的每个命令都必须被调度器认识，且跑完整个矩阵后引擎还活着
 *      ——否则用户点了一个"看起来有"的按钮，得到的是一句"暂不支持"，或者更糟：白屏；
 *   ② **落格验证**：加粗/数字格式/合并/自动求和/冻结都要在引擎数据上看出效果，
 *      而不是只看状态栏文案（文案对了但表格没动，正是"点击删除后文字没变化"那类事故）；
 *   ③ **没有假按钮**：几类"点了没反应或者会崩"的命令必须**不在**功能区里（见下方注释）。
 *
 * 选区一律用**真人手势**拿到（点网格 + 方向键 + Shift 扩选）：这套实例里 api.setSelection 设不进去，
 * 用它做断言会全部变成假通过。
 *
 * 用法：node packages/ui/scripts/check-office-excel-ui.mjs
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCEL_PAGE, bundleExcelEntry } from "./lib/officeExcelPage.mjs";
import { startOfficeHarness } from "./lib/officeEditorHarness.mjs";
import { createUiDriver, runRibbonCommandMatrix } from "./lib/officeExcelUiDriver.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");

const SAMPLE = [
  {
    name: "表1",
    status: 1,
    row: 40,
    column: 12,
    celldata: [
      { r: 0, c: 0, v: { v: 1 } },
      { r: 1, c: 0, v: { v: 2 } },
      { r: 2, c: 0, v: { v: 3 } },
      { r: 0, c: 1, v: { v: "文字" } },
      { r: 1, c: 1, v: { v: "第二行" } },
      { r: 4, c: 0, v: { f: "=SUM(A1:A3)", v: 6, m: "6" } },
    ],
  },
];

async function main() {
  const started = Date.now();
  const stage = (name) => console.log(`… ${name}（${Math.round((Date.now() - started) / 1000)}s）`);
  stage("打产物");
  const harness = await startOfficeHarness({
    prefix: "office-excel-ui-",
    pages: { "index.html": EXCEL_PAGE },
    prepareDir: (dir) =>
      bundleExcelEntry(dir, {
        repoRoot,
        editorDir,
        modules: [
          "excelCommands.ts",
          "excelRibbonTabs.ts",
          "ribbonItemSupport.ts",
          "excelStructure.ts",
          "xlsxWorkbook.ts",
          "xlsxRead.ts",
        ],
        sampleSheets: SAMPLE,
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

  await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60000 });
  const { mount, runCase } = createUiDriver({ page, mountData: SAMPLE });
  await mount();

  // ② 加粗：切换语义（再点一次要取消），并且真的落到格子数据上
  const bold = await runCase({
    from: "B2",
    command: "executeBold",
    read: () => window.__excel.api().current.getCellValue(1, 1, { type: "bl" }),
  });
  const boldOff = await page.evaluate(async () => {
    const outcome = await window.__excel.run("executeBold");
    return {
      value: window.__excel.api().current.getCellValue(1, 1, { type: "bl" }),
      message: outcome.messages.join(" / "),
      coordinates: window.__excel.api().current.getSelectionCoordinates(),
      selection: window.__excel.api().current.getSelection(),
    };
  });
  check(
    bold.selected && bold.value === 1 && boldOff.value === 0,
    `加粗是切换语义（${bold.value} → ${boldOff.value}）｜${boldOff.message}｜坐标 ${JSON.stringify(boldOff.coordinates)}｜选区 ${JSON.stringify(boldOff.selection)}`,
  );

  // ③ 数字格式
  const numberFormat = await runCase({
    from: "A1",
    command: "executeNumberFormat",
    args: ["百分比"],
    read: () => window.__excel.api().current.getCellValue(0, 0, { type: "ct" }),
  });
  check(
    numberFormat.value?.fa === "0.00%",
    `数字格式落到格子上（${JSON.stringify(numberFormat.value)}）`,
  );

  // ④ 合并居中 / 取消合并：用 Shift 扩选出一块多格选区
  const merge = await runCase({
    from: "B2",
    to: "C3",
    command: "excelMergeCenter",
    read: () => {
      const api = window.__excel.api().current;
      return {
        merge: Object.keys(api.getAllSheets()[0].config?.merge ?? {}),
        ht: api.getCellValue(1, 1, { type: "ht" }),
      };
    },
  });
  check(
    merge.selected && merge.value.merge.length === 1 && merge.value.ht === 0,
    `合并居中生效（${merge.value.merge.join(",")}，水平对齐 ${merge.value.ht}）`,
  );
  const unmerged = await page.evaluate(async () => {
    const before = Object.keys(
      window.__excel.api().current.getAllSheets()[0].config?.merge ?? {},
    ).length;
    await window.__excel.run("excelUnmerge");
    return {
      before,
      after: Object.keys(window.__excel.api().current.getAllSheets()[0].config?.merge ?? {}).length,
    };
  });
  // before 必须是 1：否则这条"取消了"可能只是"本来就没有"（假通过）
  check(
    unmerged.before === 1 && unmerged.after === 0,
    `取消合并生效（${unmerged.before} → ${unmerged.after} 处）`,
  );

  // ⑤ 清除内容 / 清除格式：内容与格式各自独立
  const cleared = await runCase({
    from: "A2",
    command: "excelClearContent",
    read: () => {
      const api = window.__excel.api().current;
      return { value: api.getCellValue(1, 0, { type: "v" }) };
    },
  });
  check(
    cleared.value.value === null || cleared.value.value === "",
    `清除内容真的清掉了（A2=${JSON.stringify(cleared.value.value)}）`,
  );

  const clearedFormat = await runCase({
    from: "A1",
    steps: [["executeBold", []]],
    command: "excelClearFormat",
    read: () => {
      const api = window.__excel.api().current;
      return {
        bold: api.getCellValue(0, 0, { type: "bl" }),
        value: api.getCellValue(0, 0, { type: "v" }),
      };
    },
  });
  // 读数口径：开着是 1、关着是字符串 "0"（引擎规范化过的），所以判"没加粗"而不是 === "0"
  check(
    String(clearedFormat.value.bold) !== "1" && clearedFormat.value.value === 1,
    `清除格式只去格式、留内容（加粗=${clearedFormat.value.bold}，A1=${clearedFormat.value.value}）`,
  );

  // ⑥ 自动求和：公式与算出来的值都要对（选区 A1:A3 → 合计写在第 4 行）
  const sum = await runCase({
    from: "A1",
    to: "A3",
    command: "excelAutoSum",
    read: () => {
      const api = window.__excel.api().current;
      return {
        formula: String(api.getCellValue(3, 0, { type: "f" }) ?? "").replace(/<[^>]+>/g, ""),
        value: api.getCellValue(3, 0, { type: "v" }),
      };
    },
  });
  check(
    /SUM\(A1:A3\)/.test(sum.value.formula) && String(sum.value.value) === "6",
    `自动求和写成公式并算出来（${sum.value.formula} → ${sum.value.value}）`,
  );

  // ⑦ 冻结：表级设置要落到 sheet 数据上（否则保存时写不回去）
  const frozen = await runCase({
    from: "A1",
    command: "excelFreezeFirstRow",
    read: () => window.__excel.api().current.getAllSheets()[0].frozen ?? null,
  });
  check(
    frozen.value?.type === "rangeRow" || frozen.value?.type === "row",
    `冻结落到表数据上（${JSON.stringify(frozen.value)}）`,
  );

  // ⑦b 行列结构操作：自己算 + 整表回灌（引擎自己的那两个 API 会崩，见 excelStructure.ts）
  const inserted = await runCase({
    from: "A2",
    command: "excelInsertRowAbove",
    read: () => {
      const api = window.__excel.api().current;
      return {
        values: [0, 1, 2, 3].map((row) => api.getCellValue(row, 0, { type: "v" })),
        formula: String(api.getCellValue(5, 0, { type: "f" }) ?? "").replace(/<[^>]+>/g, ""),
        rows: api.getAllSheets()[0].row,
      };
    },
  });
  check(
    inserted.selected &&
      JSON.stringify(inserted.value.values) === JSON.stringify([1, null, 2, 3]) &&
      inserted.value.rows === 41,
    `插入行把内容整体下移（A1..A4=${JSON.stringify(inserted.value.values)}，表 ${inserted.value.rows} 行）`,
  );
  check(
    inserted.value.formula.includes("SUM(A1:A4)"),
    `公式引用跟着改（${inserted.value.formula}）`,
  );

  const deleted = await runCase({
    from: "A2",
    command: "excelDeleteRow",
    read: () => {
      const api = window.__excel.api().current;
      return {
        values: [0, 1, 2].map((row) => api.getCellValue(row, 0, { type: "v" })),
        formula: String(api.getCellValue(3, 0, { type: "f" }) ?? "").replace(/<[^>]+>/g, ""),
      };
    },
  });
  check(
    JSON.stringify(deleted.value.values) === JSON.stringify([1, 3, null]),
    `删除行把内容整体上移（A1..A3=${JSON.stringify(deleted.value.values)}）`,
  );
  check(
    deleted.value.formula.includes("SUM(A1:A2)"),
    `删除后公式引用被收缩（${deleted.value.formula}）`,
  );

  const columnCase = await runCase({
    from: "B1",
    steps: [],
    command: "excelInsertColumnLeft",
    read: () => {
      const api = window.__excel.api().current;
      return {
        b1: api.getCellValue(0, 1, { type: "v" }),
        c1: api.getCellValue(0, 2, { type: "v" }),
        columns: api.getAllSheets()[0].column,
      };
    },
  });
  check(
    columnCase.value.c1 === "文字" && columnCase.value.columns === 13,
    `插入列把内容右移（B1=${JSON.stringify(columnCase.value.b1)}，C1=${JSON.stringify(columnCase.value.c1)}，表 ${columnCase.value.columns} 列）`,
  );

  // 整表选中：选区要落在表格实际范围（越界会让后面的写格式把引擎写崩）
  const selectAll = await runCase({
    from: "A1",
    command: "excelSelectAll",
    read: () => {
      const api = window.__excel.api().current;
      return {
        coordinates: api.getSelectionCoordinates(),
        selection: api.getSelection(),
      };
    },
  });
  check(
    selectAll.value.coordinates?.[0] === `A1:L40`,
    `整表选中落在实际范围（${selectAll.value.coordinates?.join(",")}）`,
  );
  const selectAllWrite = await page.evaluate(async () => {
    await window.__excel.run("executeBold");
    return {
      bold: window.__excel.api().current.getCellValue(0, 0, { type: "bl" }),
      alive: window.__excel.api().current != null,
    };
  });
  check(
    selectAllWrite.alive && selectAllWrite.bold === 1,
    `整表选中之后还能正常写格式（引擎没崩，加粗=${selectAllWrite.bold}）`,
  );

  // ⑧ 新增工作表：表数要真的 +1（保存时按表写回）
  const added = await runCase({
    from: "A1",
    command: "excelAddSheet",
    read: () =>
      window.__excel
        .api()
        .current.getAllSheets()
        .map((sheet) => sheet.name),
  });
  check(added.value.length === 2, `新增工作表落到表数据上（${added.value.join("、")}）`);

  // ⑨ 脏标记：选区变化不该算"未保存"，真的改内容才算
  const dirty = await page.evaluate(async () => {
    const api = window.__excel.api().current;
    const before = window.__excel.counts().ops;
    api.setSelection([{ row: [0, 0], column: [0, 0] }]);
    api.setSelection([{ row: [5, 5], column: [5, 5] }]);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const afterSelection = window.__excel.counts().ops;
    api.setCellValue(7, 0, "改了");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { before, afterSelection, afterEdit: window.__excel.counts().ops };
  });
  check(
    dirty.afterSelection === dirty.before && dirty.afterEdit > dirty.before,
    `选区变化不产生写入 op、改内容才产生（${dirty.before} → ${dirty.afterSelection} → ${dirty.afterEdit}）`,
  );

  /**
   * ⑩ 命令矩阵**最后再跑**：它会把一个实例用到"选区乱掉"的状态，前面的效果断言需要干净的实例。
   * 矩阵证明的是：每条命令都被调度器接住、跑完引擎还活着。
   */
  const matrix = await runRibbonCommandMatrix(page);
  check(matrix.tabs.length >= 4, `功能区标签齐备（${matrix.tabs.map((tab) => tab.id).join("/")}）`);
  const unknown = matrix.results.filter((item) => !item.handled);
  check(
    unknown.length === 0,
    unknown.length === 0
      ? `功能区的 ${matrix.results.length} 条命令全部被调度器接住`
      : `有命令没实现：${unknown.map((item) => item.command).join("、")}`,
  );
  const broken = matrix.results.filter((item) => !item.alive || item.error);
  if (broken.length > 0) {
    // 崩在"下一条命令"上很常见（React 的卸载是异步的）：把最后几条的形状打出来对时间线
    console.log(
      "     诊断（最后 6 条）：" +
        matrix.results
          .slice(-6)
          .map(
            (item) => `${item.command}${item.alive ? "" : "(dead)"}${JSON.stringify(item.shape)}`,
          )
          .join(" → "),
    );
  }
  check(
    broken.length === 0,
    broken.length === 0
      ? "跑完整个命令矩阵后引擎仍然可用"
      : `这些命令把引擎弄挂了：${broken.map((item) => `${item.command}:${item.error ?? "引擎实例没了"}`).join("、")}`,
  );
  const forbidden = matrix.results.filter((item) => /excelToggleGridLines/.test(item.command));
  check(forbidden.length === 0, "功能区没有「点了没反应」的命令（网格线开关）");

  await harness.close();
  if (failures.length > 0) {
    console.log(`\n${failures.length} 条未通过`);
    process.exitCode = 1;
  } else {
    console.log("\nExcel 功能区/命令检查全部通过");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
