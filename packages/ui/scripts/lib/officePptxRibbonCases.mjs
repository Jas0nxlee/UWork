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

  // ③b 折叠菜单（»）：**滚它不能关、点了要生效**（用户反馈"折叠部分没法滚动和点击"）
  // 先切回「开始」——它组分多，才会出现 »（视图只有一个组，没有 »）
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll("[data-office-ribbon-tab]")].find(
      (node) => (node.textContent ?? "").trim() === "开始",
    );
    tab?.click();
  });
  await page.waitForTimeout(300);
  const menuOpened = await page.evaluate(async () => {
    const more = document.querySelector("[data-office-ribbon-more]");
    if (!more) return { opened: false, reason: "这个宽度下没有 » （所有分组都放下了）" };
    more.click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    return { opened: Boolean(document.querySelector("[data-ribbon-dropdown]")), reason: "" };
  });
  const scrollStays = await page.evaluate(async () => {
    const panel = document.querySelector("[data-ribbon-dropdown]");
    if (!panel) return { stillOpen: false, items: 0, scrollable: false };
    const scrollable = panel.scrollHeight > panel.clientHeight + 1;
    panel.scrollTop = 40;
    panel.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      stillOpen: Boolean(document.querySelector("[data-ribbon-dropdown]")),
      items: panel.querySelectorAll("button").length,
      scrollable,
      scrollTop: panel.scrollTop,
    };
  });
  check(
    menuOpened.opened && scrollStays.stillOpen && scrollStays.items > 0,
    `折叠菜单能打开、滚动时不自己关掉（${scrollStays.items} 个项目，可滚 ${scrollStays.scrollable}，滚动后仍开着 ${scrollStays.stillOpen}）`,
  );

  // 面板里的按钮点得动：点"新建一页（空白）"要真的加一页
  const slidesBeforeMenu = await page.evaluate(() => window.__pptxPane?.slideCount?.() ?? 0);
  const clickedInMenu = await page.evaluate(() => {
    const panel = document.querySelector("[data-ribbon-dropdown]");
    const node = panel
      ? [...panel.querySelectorAll("button")].find(
          (item) => (item.getAttribute("title") ?? "") === "新建一页（空白）",
        )
      : null;
    if (!node) return false;
    node.click();
    return true;
  });
  await page.waitForTimeout(1500);
  const slidesAfterMenu = await page.evaluate(() => window.__pptxPane?.slideCount?.() ?? 0);
  check(
    clickedInMenu && slidesAfterMenu === slidesBeforeMenu + 1,
    `折叠菜单里的命令点得动（${slidesBeforeMenu} → ${slidesAfterMenu} 页）`,
  );

  // ③c 有图标的按钮**不再显示文字**（文字标签太占宽；之前正是图标名不在图标表里才退回显示文字）
  const labelWidth = await page.evaluate(async () => {
    const find = () =>
      [...document.querySelectorAll("button")].find(
        (item) => (item.getAttribute("title") ?? "") === "加粗",
      );
    let node = find();
    if (!node) {
      // 收进 » 里的分组：把它打开再找
      document.querySelector("[data-office-ribbon-more]")?.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      node = find();
    }
    if (!node) return null;
    return {
      text: (node.textContent ?? "").trim(),
      width: Math.round(node.getBoundingClientRect().width),
    };
  });
  check(
    labelWidth !== null && labelWidth.text === "" && labelWidth.width <= 40,
    `有图标的按钮只显图标（加粗按钮文字 ${JSON.stringify(labelWidth?.text)}，宽 ${labelWidth?.width}px）`,
  );

  // ③d 表格网格选择器：点「表格」→ 网格出现 → 点 3×4 → 形状列表里多一个表格
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll("[data-office-ribbon-tab]")].find(
      (node) => (node.textContent ?? "").trim() === "插入",
    );
    tab?.click();
  });
  await page.waitForTimeout(300);
  const gridOpened = await page.evaluate(async () => {
    const find = () =>
      [...document.querySelectorAll("button")].find((node) =>
        (node.getAttribute("title") ?? "").includes("插入表格"),
      );
    let node = find();
    if (!node) {
      document.querySelector("[data-office-ribbon-more]")?.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      node = find();
    }
    if (!node) return false;
    node.click();
    return true;
  });
  await page.waitForTimeout(400);
  const gridPicked = await page.evaluate(() => {
    // 网格单元格的坐标在 aria-label 上（形如"4 列 3 行"）
    const target = document.querySelector(
      '[data-office-ribbon-table-grid] [aria-label="4 列 3 行"]',
    );
    if (!target) return false;
    target.click();
    return true;
  });
  await page.waitForTimeout(1500);
  const shapes = await page.evaluate(() => window.__pptxPane?.shapeNames?.() ?? []);
  const blocks = await page.evaluate(() => document.querySelectorAll("[data-pptx-block]").length);
  void blocks;
  check(
    gridOpened && gridPicked && shapes.filter((name) => name.startsWith("表格")).length >= 1,
    `功能区的表格网格能插出表格（形状：${shapes.join("、")}）`,
  );

  // ③e 表格工具：选中表格才出现「表格」上下文标签，逐个按钮点下去都要改到 XML
  await page.evaluate(() => {
    if (!document.querySelector("[data-pptx-task-pane]")) {
      document.querySelector("[data-pptx-open-format]")?.click();
    }
    document.querySelector('[data-pptx-shape="表格 1"]')?.click();
  });
  await page.waitForTimeout(400);
  const tableTab = await page.evaluate(() =>
    [...document.querySelectorAll("[data-office-ribbon-tab]")].some(
      (node) => (node.textContent ?? "").trim() === "表格",
    ),
  );
  check(tableTab, "选中表格时出现「表格」上下文标签（与 Word 的表格工具同一做法）");

  const tableToolRun = await page.evaluate(async () => {
    const tab = [...document.querySelectorAll("[data-office-ribbon-tab]")].find(
      (node) => (node.textContent ?? "").trim() === "表格",
    );
    tab?.click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const click = async (title) => {
      const find = () =>
        [...document.querySelectorAll("button")].find(
          (node) => (node.getAttribute("title") ?? "") === title,
        );
      let node = find();
      if (!node) {
        document.querySelector("[data-office-ribbon-more]")?.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        node = find();
      }
      if (!node) return false;
      node.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return true;
    };
    const read = () => {
      const xml = window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "";
      return {
        size: window.__pptx.tableSizeOf(xml, "表格 1"),
        options: window.__pptx.tableOptionsOf(xml, "表格 1"),
        hasBorder: /<a:lnL[ >]/.test(xml),
      };
    };
    const before = read();
    const addedRow = await click("在这一格下方插入一行");
    const afterRow = read();
    const merged = await click("把这一格与下面一格合并");
    const afterMerge = read();
    const bordered = await click("给这一格加四边边框");
    const afterBorder = read();
    const styled = await click("首行加粗/上底色（开关）");
    const afterStyle = read();
    return {
      addedRow,
      merged,
      bordered,
      styled,
      rowsBefore: before.size?.rows ?? null,
      rowsAfter: afterRow.size?.rows ?? null,
      mergedMarks: /rowSpan="2"|vMerge="1"/.test(
        window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "",
      ),
      borderBefore: before.hasBorder,
      borderAfter: afterBorder.hasBorder,
      styleBefore: before.options?.firstRow ?? null,
      styleAfter: afterStyle.options?.firstRow ?? null,
      void: afterMerge,
    };
  });
  check(
    tableToolRun.addedRow && tableToolRun.rowsAfter === (tableToolRun.rowsBefore ?? 0) + 1,
    `表格工具：下方插入行（${tableToolRun.rowsBefore} → ${tableToolRun.rowsAfter} 行）`,
  );
  check(
    tableToolRun.merged && tableToolRun.mergedMarks,
    "表格工具：把这一格与下面一格合并（XML 里出现 rowSpan/vMerge）",
  );
  check(
    tableToolRun.bordered && !tableToolRun.borderBefore && tableToolRun.borderAfter,
    "表格工具：给单元格加四边边框（XML 里出现 a:lnL）",
  );
  check(
    tableToolRun.styled && tableToolRun.styleAfter === !tableToolRun.styleBefore,
    `表格工具：首行突出是开关（${tableToolRun.styleBefore} → ${tableToolRun.styleAfter}）`,
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
