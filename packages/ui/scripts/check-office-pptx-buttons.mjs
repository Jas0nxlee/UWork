/**
 * PPT 编辑位的**全按键点测**（与 Excel 的 check-office-excel-buttons 同口径）。
 *
 * 跑法：node packages/ui/scripts/check-office-pptx-buttons.mjs
 * 需要 OFFICE_CHECK_CHROMIUM 指向无头 Chromium（系统装了 playwright 的无头壳时可不设）。
 *
 * 它证明的是"用户点得到、点了有反应"：功能区每个按钮（含收进 `»` 的）、每个下拉项、
 * 右栏每个控件（几何输入框 / 文字与段落按钮 / 层级 / 增删）、缩略图面板的增删排序与切页、
 * 画布上的缩放条与手柄、拖动、Ctrl+滚轮、双击就地改字。判据＝不报错 + 指纹至少变一样。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PPTX_PAGE, bundlePptxEntry } from "./lib/officePptxPage.mjs";
import { startOfficeHarness } from "./lib/officeEditorHarness.mjs";
import { createReport } from "./lib/checkReport.mjs";
import { makePptxKnownIssueCheck, runPptxButtonCases } from "./lib/officePptxButtonCases.mjs";
import { buildPptxKeyCases } from "./lib/officePptxKeyCases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");

async function main() {
  const report = createReport();
  const { check, stage } = report;
  stage("打产物");
  const harness = await startOfficeHarness({
    prefix: "office-pptx-buttons-",
    pages: { "index.html": PPTX_PAGE },
    copies: {
      [join(repoRoot, "packages/ui/test/fixtures/office-editor-image.png")]:
        "office-editor-image.png",
    },
    prepareDir: (dir) =>
      bundlePptxEntry(dir, {
        repoRoot,
        editorDir,
        modules: [
          "pptText.ts",
          "pptShapes.ts",
          "pptSlides.ts",
          "pptPicture.ts",
          "pptxValidate.ts",
          "usePptxDocument.ts",
        ],
      }),
    viewport: { width: 1280, height: 900 },
  });
  stage("页面就绪");
  const { page } = harness;
  await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60000 });
  // 删除类命令会弹确认框：默认一律同意（用例里个别步骤会自己接管）
  page.on("dialog", (dialog) => {
    // 用例里个别步骤自己接管对话框时会与这里撞车，包一层免得把整条检查打挂
    dialog.accept().catch(() => {});
  });

  const mountPane = async () => {
    await page.evaluate(async () => {
      const { bytes } = await window.__pptx.fixture();
      await window.__pptx.mountPane(bytes.slice(0));
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await page.waitForTimeout(100);
      if (await page.evaluate(() => Boolean(window.__pptxPane?.canvas?.()?.ready))) return;
    }
  };

  /** 点功能区的按钮：找不到就先展开 `»` 面板（折叠状态也要能用）。 */
  const clickRibbon = async (title, tabLabel) => {
    if (tabLabel) {
      await page.evaluate((label) => {
        const tab = [...document.querySelectorAll("[data-office-ribbon-tab]")].find(
          (node) => (node.textContent ?? "").trim() === label,
        );
        tab?.click();
      }, tabLabel);
      await page.waitForTimeout(200);
    }
    const click = () =>
      page.evaluate((wanted) => {
        const node = [...document.querySelectorAll("button")].find(
          (item) => (item.getAttribute("title") ?? "") === wanted,
        );
        if (!node) return false;
        node.click();
        return true;
      }, title);
    if (await click()) return true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const toggled = await page.evaluate(() => {
        const more = document.querySelector("[data-office-ribbon-more]");
        if (!more) return false;
        more.click();
        return true;
      });
      if (!toggled) return false;
      await page.waitForTimeout(250);
      if (await click()) return true;
    }
    return false;
  };

  // 形状类命令需要先选中一个形状：预选最上面那个
  const selectShape = async () => {
    await page.evaluate(() => {
      if (!document.querySelector("[data-pptx-task-pane]")) {
        document.querySelector("[data-pptx-open-format]")?.click();
      }
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => document.querySelector("[data-pptx-shape]")?.click());
    await page.waitForTimeout(200);
  };

  await runPptxButtonCases({
    page,
    report,
    mountPane: async () => {
      await mountPane();
      await selectShape();
    },
    clickRibbon,
  });

  stage("关键功能（具体断言）");
  // 与点测共用"已知问题不算失败"的过滤器（未修的看得到，但不把门禁染红）
  const keyCheck = makePptxKnownIssueCheck(report).check;
  for (const item of buildPptxKeyCases({
    page,
    mountPane: async () => {
      await mountPane();
      await selectShape();
    },
    clickRibbon,
  })) {
    try {
      const result = await item.run();
      keyCheck(result.ok, `${item.name}（${result.detail}）`);
    } catch (error) {
      keyCheck(false, `${item.name} 抛错：${String(error).slice(0, 120)}`);
    }
  }

  await harness.close();
  report.finish(
    "PPT 全按键点测通过（功能区的按钮与下拉项、右栏控件、缩略图面板、画布交互都被真实点过）",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
