/**
 * PPT 编辑位的**界面级断言**（形状列表 / 检查器 / 新建文本框 / 幻灯片操作）。
 *
 * 抽出来的原因：仓库规矩单文件 ≤400 行；而这几条"在真界面上点"的检查与
 * "数据层对不对"的那批断言本来也是两类。
 */
export async function runPptxUiCases({ page, check }) {
  // ⑧ 界面：形状列表 / 检查器 / 新建文本框 / 幻灯片操作（都在真编辑位里点）
  const uiEdit = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    await window.__pptx.mountPane(bytes.slice(0));
    await new Promise((resolve) => setTimeout(resolve, 400));
    // 形状列表与文本块都在右侧窗格里，窗格默认收起 → 先点开
    document.querySelector("[data-pptx-open-format]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      shapeChips: Array.from(document.querySelectorAll("[data-pptx-shape]")).map((n) =>
        n.getAttribute("data-pptx-shape"),
      ),
      slideButtons: document.querySelectorAll("[data-pptx-slide]").length,
      hasSlideOps: [
        "[data-slide-add]",
        "[data-slide-duplicate]",
        "[data-slide-delete]",
        "[data-slide-up]",
        "[data-slide-down]",
      ].every((selector) => Boolean(document.querySelector(selector))),
      hasAddTextBox: Boolean(document.querySelector("[data-shape-add-textbox]")),
    };
  });
  check(
    uiEdit.shapeChips.length === 2 && uiEdit.hasAddTextBox,
    `编辑位列出形状并能新建文本框（${uiEdit.shapeChips.join("、")}）`,
  );
  check(
    uiEdit.slideButtons === 2 && uiEdit.hasSlideOps,
    `幻灯片列表与增删排序按钮都在（${uiEdit.slideButtons} 页）`,
  );

  // 选中一个形状 → 检查器出现 → 改宽度 → 当前 XML 真的变了
  await page.click('[data-pptx-shape="标题 1"]');
  await page.waitForSelector("[data-shape-inspector]", { timeout: 5000 });
  const beforeWidth = await page.evaluate(() => {
    const api = window.__pptxPane;
    return api?.shapeBounds?.("标题 1") ?? null;
  });
  await page.fill("[data-shape-field='width']", "12");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const afterWidth = await page.evaluate(() => window.__pptxPane?.shapeBounds?.("标题 1") ?? null);
  check(
    beforeWidth !== null && afterWidth !== null && Math.abs(afterWidth - 12 * 360000) < 2,
    `检查器里改宽度落到 XML（${beforeWidth} → ${afterWidth} EMU）`,
  );

  // 点“+ 新建文本框” → 形状数 +1
  const shapesBefore = await page.evaluate(
    () => document.querySelectorAll("[data-pptx-shape]").length,
  );
  await page.click("[data-shape-add-textbox]");
  await page.waitForTimeout(400);
  const shapesAfter = await page.evaluate(
    () => document.querySelectorAll("[data-pptx-shape]").length,
  );
  check(
    shapesAfter === shapesBefore + 1,
    `新建文本框后形状数 +1（${shapesBefore} → ${shapesAfter}）`,
  );

  // 幻灯片级：点“+ 新页” → 页数 +1
  const slidesBefore = await page.evaluate(
    () => document.querySelectorAll("[data-pptx-slide]").length,
  );
  await page.click("[data-slide-add]");
  await page.waitForTimeout(1200);
  const slidesAfter = await page.evaluate(
    () => document.querySelectorAll("[data-pptx-slide]").length,
  );
  check(
    slidesAfter === slidesBefore + 1,
    `新建幻灯片后页数 +1（${slidesBefore} → ${slidesAfter}）`,
  );
}
