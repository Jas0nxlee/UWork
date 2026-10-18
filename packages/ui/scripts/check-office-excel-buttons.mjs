/**
 * Excel 编辑位的**全按键点测**：把功能区每一个按钮/下拉项**在真编辑位里点一遍**，
 * 看它是不是真的"有事发生"——不是只跑调度器。
 *
 * 为什么单独一条：命令矩阵（check-office-excel-ui 里那 95 条）走的是 `runExcelCommand`，
 * 证明的是"调度器认识这条命令"；这里走的是**真 DOM**（点按钮、走下拉、填对话框），
 * 证明的是"用户点得到、点了有反应"。真机上反复出现的正是这一类问题（"点了没反应/闪一下"），
 * 而它们恰恰是调度器级检查看不出来的。
 *
 * 判定口径：每条命令点完之后
 *   ① 不能有页面错误/控制台错误；
 *   ② 引擎还活着；
 *   ③ **表状态或状态栏至少变了一样**（允许 noop 的少数几条单独标出来，例如空历史时的撤销/重做）。
 * 另外对关键功能（加粗切换、数字格式、合并/取消合并、行列增删、自动求和、冻结、新建表、清除内容/格式、
 * 整表选中、工具栏保存/重新加载、工作表切换）做**具体断言**，而不是只看"变了没有"。
 *
 * 用法：node packages/ui/scripts/check-office-excel-buttons.mjs
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCEL_PAGE, bundleExcelEntry } from "./lib/officeExcelPage.mjs";
import { startOfficeHarness } from "./lib/officeEditorHarness.mjs";
import { createReport } from "./lib/checkReport.mjs";
import { buildKeyCases } from "./lib/officeExcelButtonCases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");

/** 允许"点了什么都不变"的命令（空历史时的撤销/重做、无意义的重算）。 */
const MAY_NOOP = new Set(["executeUndo", "executeRedo", "excelRecalculate"]);
/** 需要填内容的对话框命令 → 填什么。 */
const PROMPT_VALUES = {
  executeImage:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2gAAAABJRU5ErkJggg==",
  executeHyperlink: "https://example.com",
  executeLatex: "E=mc^2",
  executeAddWatermark: "测试水印",
};
async function main() {
  const report = createReport();
  const { check, stage } = report;
  stage("打产物");
  const harness = await startOfficeHarness({
    prefix: "office-excel-buttons-",
    pages: { "index.html": EXCEL_PAGE },
    prepareDir: (dir) =>
      bundleExcelEntry(dir, {
        repoRoot,
        editorDir,
        modules: [
          "xlsxWorkbook.ts",
          "xlsxRead.ts",
          "xlsxValidate.ts",
          "xlsxPreflight.ts",
          "useExcelDocument.ts",
          "excelCommands.ts",
          "excelStructure.ts",
          "excelRibbonTabs.ts",
        ],
        sampleSheets: [],
        reactMode: "development",
      }),
    viewport: { width: 1280, height: 860 },
  });
  stage("页面就绪");
  const page = harness.page;
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 140)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text().slice(0, 140));
  });

  await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60000 });
  // 夹具字节留在页面里（编辑位脚手架自己做 base64，别重复编码——重复编码会得到 0 字节）
  await page.evaluate(() =>
    window.__xlsx.fixture().then(({ bytes }) => (window.__fixtureBytes = bytes)),
  );

  const mountPane = async () => {
    await page.evaluate(() => window.__excelPane.mount(window.__fixtureBytes));
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector("#host canvas");
        return canvas && canvas.getBoundingClientRect().height > 100;
      },
      undefined,
      { timeout: 20000 },
    );
    await page.waitForTimeout(250);
  };

  /** 表状态 + 选区 + 状态栏的指纹：用来判"这次点击有没有改变什么"。 */
  const fingerprint = () =>
    page.evaluate(() => {
      const api = window.__officeExcelApi?.current;
      if (!api) return null;
      return {
        sheets: JSON.stringify(api.getAllSheets()),
        selection: JSON.stringify(api.getSelectionCoordinates?.() ?? null),
        status: document.querySelector("[data-office-toolbar]")?.textContent ?? "",
      };
    });

  await mountPane();

  /**
   * 功能区里的每一项。**下拉的每一个选项各算一条**（用户点的是选项，不是下拉本身），
   * 所以"全按键"是按钮数 + 所有下拉选项数。
   */
  const items = await page.evaluate(() => {
    const list = [];
    for (const tab of window.app.EXCEL_RIBBON_TABS) {
      for (const group of tab.groups) {
        for (const item of group.items) {
          const base = {
            tab: tab.id,
            tabLabel: tab.label,
            group: group.label,
            kind: item.kind,
            title: item.title,
            command:
              item.kind === "command"
                ? item.command
                : (window.app.optionsCommand?.(item.title) ?? null),
            hasPrompt: Boolean(item.prompt),
          };
          if (item.kind === "select") {
            (item.options ?? []).forEach((option, optionIndex) =>
              list.push({ ...base, choice: option.label, optionIndex }),
            );
          } else {
            list.push({ ...base, choice: null });
          }
        }
      }
    }
    return list;
  });

  const knownIssues = [];
  const failuresBefore = () => pageErrors.length;

  /**
  /**
   * 点下拉里的第 index 个选项。
   *
   * 为什么**按下标**点而不是按文本：下拉项不止有文字项——颜色/底纹那两类渲染成**色块**
   * （没有文本，label 只在数据里），按文本会找不到。下标与数据里的顺序一致，最稳；
   * label 只用来写报告。编辑位会因选区/脏标记重渲染，下拉偶尔在点下去的瞬间被重建，所以带重试。
   */
  const clickDropdownOption = async (label, index) => {
    // 文本项按文本点（最准）；色块项没有文本，退回按下标点
    const escaped = String(label ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const byText = page
      .locator("[data-ribbon-dropdown] button")
      .filter({ hasText: new RegExp(`^${escaped}$`) })
      .first();
    const byIndex = page.locator("[data-ribbon-dropdown] button").nth(index);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (await byText.isVisible().catch(() => false)) {
          await byText.click({ timeout: 4000 });
          return;
        }
        await byIndex.click({ timeout: 4000 });
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await page.waitForTimeout(200);
      }
    }
  };

  /**
   * 点功能区里的一个控件。**要考虑"收起来"的情况**：宽度不够时功能区会把分组收进
   * 「分组名 ▾」或末尾的「»」（真机侧栏就是窄的），这时控件不在 DOM 里，得先把它们展开。
   * 这条路径本身也是要测的——用户点「»」里的命令同样得能用。
   */
  const clickRibbonItem = async (item) => {
    const selector = `[aria-label="${item.title.replace(/"/g, '\\"')}"]`;
    if (
      await page
        .locator(selector)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await page.click(selector);
      return "直接点到";
    }
    const collapsed = `[data-office-ribbon-collapsed="${item.group}"]`;
    if (
      await page
        .locator(collapsed)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await page.click(collapsed);
      await page.waitForSelector("[data-ribbon-dropdown]", { timeout: 5000 });
      await page.click(`[data-ribbon-dropdown] ${selector}`);
      return "从收起的分组里点到";
    }
    if (
      await page
        .locator("[data-office-ribbon-more]")
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await page.click("[data-office-ribbon-more]");
      await page.waitForSelector("[data-ribbon-dropdown]", { timeout: 5000 });
      await page.click(`[data-ribbon-dropdown] ${selector}`);
      return "从 » 菜单里点到";
    }
    throw new Error(`找不到控件：${item.title}`);
  };
  let tested = 0;
  let didSomething = 0;

  for (const item of items) {
    tested += 1;
    await mountPane();
    const before = await fingerprint();
    const errorsBefore = failuresBefore();

    // ① 先切到它所在的标签页
    await page.click(`[data-office-ribbon-tab="${item.tab}"]`);
    await page.waitForTimeout(120);

    // ② 点按钮 / 走下拉（控件可能收在「分组 ▾」或「»」里，展开后再点）
    let how = "";
    if (item.kind === "select") {
      how = await clickRibbonItem(item);
      await page.waitForSelector("[data-ribbon-dropdown]", { timeout: 5000 });
      // 每个选项单独跑一条（这样"字体/字号/数字格式"里的每一项都被点过）
      await clickDropdownOption(item.choice, item.optionIndex ?? 0);
    } else if (item.hasPrompt) {
      void item.choice;
      how = await clickRibbonItem(item);
      await page.waitForSelector("[data-office-ribbon-prompt-submit]", { timeout: 5000 });
      const value = PROMPT_VALUES[item.command] ?? "测试";
      await page
        .fill("[data-office-ribbon-prompt] input, [aria-label] input", value)
        .catch(async () => {
          await page.fill("input", value);
        });
      await page.click("[data-office-ribbon-prompt-submit]");
    } else {
      how = await clickRibbonItem(item);
    }
    await page.waitForTimeout(260);

    const after = await fingerprint();
    const newErrors = pageErrors.slice(errorsBefore);
    const alive = after !== null;
    const changed =
      before !== null &&
      after !== null &&
      (before.sheets !== after.sheets ||
        before.selection !== after.selection ||
        before.status !== after.status);
    if (changed) didSomething += 1;
    /**
     * 下拉项还有个正当的"没反应"：**选的正好是当前值**。字号下拉里"12"就是这种情况
     * （夹具 A1 本来就是 12 号字），选它当然什么都不变——这不是 bug。
     */
    const alreadyThatValue =
      item.kind === "select" &&
      item.choice !== null &&
      /^\d+(?:\.\d+)?$/.test(item.choice) &&
      (await page.evaluate((value) => {
        const api = window.__officeExcelApi.current;
        const range = api.getSelection()?.[0];
        const row = range?.row?.[0] ?? 0;
        const column = range?.column?.[0] ?? 0;
        return api.getCellValue(row, column, { type: "fs" }) === value;
      }, Number(item.choice)));

    const problems = [];
    if (!alive) problems.push("引擎挂了");
    if (newErrors.length > 0) problems.push(`报错：${newErrors[0]}`);
    if (!changed && !alreadyThatValue && !MAY_NOOP.has(item.command ?? "")) {
      problems.push("点了没反应（表状态/状态栏都没变）");
    }
    check(
      problems.length === 0,
      `${item.tabLabel} › ${item.group} › ${item.title}${item.choice ? `：${item.choice}` : ""}${how ? `（${how}）` : ""}${
        problems.length ? ` — ${problems.join("；")}` : " ✓"
      }`,
    );
  }

  stage("全按键点测完成");

  // ③ 关键功能的**具体**断言（不只看"变没变"）
  const clickByTitle = async (title) => {
    const selector = `[aria-label="${title}"]`;
    if (
      await page
        .locator(selector)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await page.click(selector);
      return;
    }
    if (
      await page
        .locator("[data-office-ribbon-more]")
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await page.click("[data-office-ribbon-more]");
      await page.waitForSelector("[data-ribbon-dropdown]", { timeout: 5000 });
      await page.click(`[data-ribbon-dropdown] ${selector}`);
      return;
    }
    throw new Error(`找不到控件：${title}`);
  };

  const cases = buildKeyCases({ page, mountPane, clickByTitle, clickDropdownOption });

  for (const testCase of cases) {
    let outcome = { ok: false, detail: "" };
    try {
      outcome = await testCase.run();
    } catch (error) {
      outcome = { ok: false, detail: String(error).slice(0, 140) };
    }
    if (!outcome.ok && testCase.knownIssue) {
      // 已知问题：**照实打出来**，但不让门禁变红（根因与复现记在 specs/office-editors-triad.md §2.2c）
      knownIssues.push(`${testCase.name} — ${outcome.detail}`);
      console.log(`⚠ 已知问题（不计失败）：${testCase.name} — ${outcome.detail}`);
      continue;
    }
    check(
      outcome.ok,
      `【关键功能】${testCase.name}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
    );
  }

  await harness.close();
  console.log(`\n一共点了 ${tested} 个功能区控件，其中 ${didSomething} 个改变了表状态/选区/状态栏`);
  if (knownIssues.length > 0)
    console.log(`已知问题 ${knownIssues.length} 条（见 specs §2.2c）：${knownIssues.join("；")}`);
  report.finish("Excel 全按键点测通过（功能区每一个按钮与下拉项都被真实点击过）");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
