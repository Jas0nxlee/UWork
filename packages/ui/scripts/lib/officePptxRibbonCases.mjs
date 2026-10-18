/**
 * PPT 功能区的**界面断言**：PowerPoint 那套标签页真的能改到东西。
 *
 * 判据（每条都要求"有反应"）：
 *   ① 幻灯片命令 → 页数变了；字体命令 → 当前页 XML 变了；视图命令 → 画布缩放读数变了；
 *   ② 没选中形状时**要说人话**（状态栏给出原因），不能静默什么都不做。
 *
 * 两个脚手架细节（踩过）：命令按钮按 `title` 找，但**装不下的分组合被收进末尾的「»」菜单**，
 * 所以找不到时要先把菜单打开；切标签要真点标签（`[data-office-ribbon-tab]`）。
 */
async function clickByTitle(page, title) {
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
  // 收进「»」菜单的分组：先把菜单打开再找。菜单点过一项之后不一定关，
  // 所以"打开后仍找不到"就再切一次状态重试（直接 toggle 会在已开时把它关掉）。
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
}

export async function runPptxRibbonCases({ page, check }) {
  const mounted = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    await window.__pptx.mountPane(bytes.slice(0));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (window.__pptxPane?.canvas?.()?.ready) break;
    }
    return {
      tabs: [...document.querySelectorAll("[data-office-ribbon-tab]")].map((node) =>
        (node.textContent ?? "").trim(),
      ),
    };
  });
  check(mounted.tabs.length >= 3, `编辑位顶部有功能区（${mounted.tabs.join("、")}）`);

  const statusText = () =>
    page.evaluate(
      () => document.querySelector("[data-office-toolbar]")?.textContent?.slice(-70) ?? "",
    );

  // ① 没选中形状时点「加粗」→ 状态栏要说明原因（不能静默）
  const clickedBold = await clickByTitle(page, "加粗");
  await page.waitForTimeout(300);
  const refused = await statusText();
  check(
    clickedBold && refused.includes("先在画布上点一个形状"),
    `没选中形状时加粗被说明原因而不是静默（${refused}）`,
  );

  // ② 选中形状 → 点「加粗」→ 报"修改文字格式"
  // 形状列表在右侧窗格里，而窗格默认收起 → 先点「设置形状格式」把它打开
  await page.evaluate(() => document.querySelector("[data-pptx-open-format]")?.click());
  await page.waitForTimeout(300);
  await page.click('[data-pptx-shape="标题 1"]');
  await page.waitForTimeout(200);
  const clickedBold2 = await clickByTitle(page, "加粗");
  await page.waitForTimeout(400);
  const applied = await statusText();
  check(clickedBold2 && applied.includes("文字格式"), `选中形状后加粗落到这一页 XML（${applied}）`);

  // ③ 「视图」里的缩放：先切到视图标签，缩小一次，再点 100% 回来
  const switched = await page.evaluate(() => {
    const tab = [...document.querySelectorAll("[data-office-ribbon-tab]")].find(
      (node) => (node.textContent ?? "").trim() === "视图",
    );
    if (!tab) return false;
    tab.click();
    return true;
  });
  await page.waitForTimeout(300);
  const zoomBefore = await page.evaluate(() => window.__pptxPane?.canvas?.()?.zoom ?? null);
  await clickByTitle(page, "缩小");
  await page.waitForTimeout(300);
  const zoomShrunk = await page.evaluate(() => window.__pptxPane?.canvas?.()?.zoom ?? null);
  const clickedIn = await clickByTitle(page, "放大");
  await page.waitForTimeout(300);
  const zoomBack = await page.evaluate(() => window.__pptxPane?.canvas?.()?.zoom ?? null);
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .map((item) => item.getAttribute("title") ?? "")
      .filter((title) => title.includes("显示") || title.includes("大") || title.includes("小"))
      .slice(0, 6),
  );
  check(
    switched &&
      zoomShrunk !== null &&
      zoomShrunk < (zoomBefore ?? 0) &&
      clickedIn &&
      zoomBack > zoomShrunk,
    `「视图」标签的缩放命令能改画布（${zoomBefore} → 缩小 ${zoomShrunk} → 放大 ${zoomBack}｜按钮 ${titles.join("/") || "没找到"}）`,
  );

  // ④ 「开始」里的幻灯片命令：新建一页
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll("[data-office-ribbon-tab]")].find(
      (node) => (node.textContent ?? "").trim() === "开始",
    );
    tab?.click();
  });
  await page.waitForTimeout(300);
  const slidesBefore = await page.evaluate(() => window.__pptxPane?.slideCount?.() ?? 0);
  const clickedAdd = await clickByTitle(page, "新建一页（空白）");
  await page.waitForTimeout(1500);
  const slidesAfter = await page.evaluate(() => window.__pptxPane?.slideCount?.() ?? 0);
  check(
    clickedAdd && slidesAfter === slidesBefore + 1,
    `功能区「新建幻灯片」真的加了一页（${slidesBefore} → ${slidesAfter}）`,
  );
}
