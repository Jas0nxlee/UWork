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
        modules: ["excelCommands.ts", "excelRibbonTabs.ts", "ribbonItemSupport.ts"],
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
  const mount = async () => {
    await page.evaluate((data) => window.__excel.mount({ data }), SAMPLE);
    await page.waitForSelector("#host canvas", { timeout: 20000 });
  };
  await mount();

  // —— 选区：点网格 + 方向键走到目标格（可选 Shift 扩选）——
  const address = () =>
    page.evaluate(() => window.__excel.api().current?.getSelectionCoordinates()?.[0] ?? "");
  const columnOf = (value) => value.replace(/\d+/g, "");
  const rowOf = (value) => Number(value.replace(/\D+/g, ""));
  const walkTo = async (target) => {
    const trace = [];
    // 先点一下网格：焦点不在格子上时，方向键根本没人听（walkTo 会一路超时，
    // 后面的断言就全变成"改到了 A1"）
    const box = await page.locator("#host canvas").first().boundingBox();
    await page.mouse.click(Math.round(box.x + 200), Math.round(box.y + 60));
    await page.waitForTimeout(80);
    for (let step = 0; step < 80; step += 1) {
      const current = await address();
      if (trace.length < 10) trace.push(current);
      if (step === 79 && current !== target) {
        console.log(`     诊断 walkTo(${target}): ${trace.join(" → ")} …超时`);
      }
      if (current === target) return true;
      const currentColumn = columnOf(current);
      const targetColumn = columnOf(target);
      if (currentColumn !== targetColumn) {
        await page.keyboard.press(currentColumn < targetColumn ? "ArrowRight" : "ArrowLeft");
      } else {
        await page.keyboard.press(rowOf(current) < rowOf(target) ? "ArrowDown" : "ArrowUp");
      }
      // 引擎把选区落到 context 是异步的：读太早会拿到**上一次**的地址，于是同方向连按、
      // 一路顶到边界再也回不来（walkTo 假失败，后面的断言全变成"改到了 A1"）
      await page.waitForTimeout(60);
    }
    return false;
  };
  /** 从 `from` 扩选到 `to`（Shift + 方向键），得到一块多格选区。 */
  const selectRange = async (from, to) => {
    const box = await page.locator("#host canvas").first().boundingBox();

    await page.mouse.click(Math.round(box.x + 200), Math.round(box.y + 60));

    if (!(await walkTo(from))) return false;
    await page.keyboard.down("Shift");
    // 按**差值**扩选（不是"按一下就够"）：A1→A3 需要两下方向键
    const columnDelta = to.length && columnOf(from) !== columnOf(to) ? columnOf(to).length - columnOf(from).length : 0;
    for (let step = 0; step < Math.abs(columnDelta); step += 1) {
      await page.keyboard.press(columnDelta > 0 ? "ArrowRight" : "ArrowLeft");
    }
    const rowDelta = rowOf(to) - rowOf(from);
    for (let step = 0; step < Math.abs(rowDelta); step += 1) {
      await page.keyboard.press(rowDelta > 0 ? "ArrowDown" : "ArrowUp");
    }
    await page.keyboard.up("Shift");
    await page.waitForTimeout(60);
    return true;
  };

  /** 每条断言都在**新挂载的实例**上跑：坏状态不互相污染，一条断言只验一件事。 */
  const runCase = async ({ steps = [], from, to, command, args = [], read }) => {
    await mount();
    for (const [name, stepArgs] of steps) {
      await page.evaluate(([n, a]) => window.__excel.run(n, a), [name, stepArgs]);
    }
    const selected = to ? await selectRange(from, to) : await walkTo(from);
    await page.evaluate(([n, a]) => window.__excel.run(n, a), [command, args]);
    return { selected, value: await page.evaluate(read) };
  };

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
    const before = Object.keys(window.__excel.api().current.getAllSheets()[0].config?.merge ?? {}).length;
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
      return { bold: api.getCellValue(0, 0, { type: "bl" }), value: api.getCellValue(0, 0, { type: "v" }) };
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

  // ⑧ 新增工作表：表数要真的 +1（保存时按表写回）
  const added = await runCase({
    from: "A1",
    command: "excelAddSheet",
    read: () => window.__excel.api().current.getAllSheets().map((sheet) => sheet.name),
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
   * ⑩ 命令矩阵**最后再跑**：它会把一个实例用到"选区乱掉"的状态（结构性命令 + 新增表），
   * 前面那些效果断言需要干净的实例。所以矩阵放在最后，用来证明"整条功能区跑完引擎还活着、
   * 每条命令都被调度器接住"。
   */
  const runMatrix = async () => {
    const matrix = await page.evaluate(async () => {
      const tabs = window.app.EXCEL_RIBBON_TABS;
      const commands = [];
      for (const tab of tabs) {
        for (const group of tab.groups) {
          for (const item of group.items) {
            if (item.kind === "command") commands.push({ command: item.command, args: item.args ?? [] });
            // 下拉走的是"标题 → 命令"的映射（与视图件里同一份 optionsCommand）
            if (item.kind === "select") {
              for (const option of item.options ?? []) {
                commands.push({ command: window.app.optionsCommand(item.title), args: option.args });
              }
            }
          }
        }
      }
      const results = [];
      for (const entry of commands) {
        let error = null;
        let handled = false;
        let message = "";
        try {
          const outcome = await window.__excel.run(entry.command, entry.args);
          handled = outcome.handled;
          message = outcome.messages.join(" / ");
        } catch (thrown) {
          error = String(thrown).slice(0, 160);
        }
        const alive = window.__excel.api().current != null;
        results.push({ ...entry, handled, message, error, alive });
        if (error || !alive) break;
      }
      return {
        tabs: tabs.map((tab) => ({ id: tab.id, groups: tab.groups.length })),
        results,
      };
    });
    check(matrix.tabs.length >= 4, `功能区标签齐备（${matrix.tabs.map((tab) => tab.id).join("/")}）`);
    const unknown = matrix.results.filter((item) => !item.handled);
    check(
      unknown.length === 0,
      unknown.length === 0
        ? `功能区的 ${matrix.results.length} 条命令全部被调度器接住`
        : `有命令没实现：${unknown.map((item) => item.command).join("、")}`,
    );
    const broken = matrix.results.filter((item) => !item.alive || item.error);
    check(
      broken.length === 0,
      broken.length === 0
        ? "跑完整个命令矩阵后引擎仍然可用"
        : `这些命令把引擎弄挂了：${broken
            .map((item) => `${item.command}:${item.error ?? "引擎实例没了"}`)
            .join("、")}`,
    );

    /**
     * ③ 没有假按钮：这些命令要么会破坏表格状态、要么改不动（实测记录见 specs/office-editors-triad.md）。
     * 这条断言是提醒：将来有人把按钮加回来时，先看那份复现记录。
     */
    const forbidden = matrix.results.filter((item) =>
      /excel(Insert|Delete)(Row|Column)|excelSelectAll|excelToggleGridLines/.test(item.command),
    );
    check(
      forbidden.length === 0,
      "功能区没有「点了会崩 / 点了没反应」的命令（行列结构操作、整表选中、网格线开关）",
    );

  };
  await runMatrix();

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
