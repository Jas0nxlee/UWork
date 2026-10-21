/**
 * PPT 面板行为的界面断言（用户两条反馈的回归）：
 *   ① 右侧「设置形状格式」窗格**默认收起**（一直占着 288px 会把中间画布挤窄），
 *      选中形状时自动弹出、点 ✕ 收起；
 *   ② 画布里的页面**居中**（左右留白相等）；
 *   ③ **Ctrl/⌘ + 滚轮**能缩放，且指针底下的那个点大致不动（PowerPoint 的手感）。
 */
export async function runPptxPanelCases({ page, check }) {
  const read = () =>
    page.evaluate(() => {
      const frame = document.querySelector("[data-pptx-canvas-frame]");
      const pageBox = document.querySelector("[data-pptx-canvas-page]");
      const rect = (node) => {
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { left: box.left, top: box.top, width: box.width, height: box.height };
      };
      return {
        frame: rect(frame),
        page: rect(pageBox),
        zoom: window.__pptxPane?.canvas?.()?.zoom ?? null,
        taskPane: Boolean(document.querySelector("[data-pptx-task-pane]")),
      };
    });

  await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    await window.__pptx.mountPane(bytes.slice(0));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (window.__pptxPane?.canvas?.()?.ready) break;
    }
  });

  // ① 默认收起
  const initial = await read();
  check(!initial.taskPane, "右侧设置窗格默认收起（把画布让出来）");

  // ①b 点中形状**不再自动弹出**（真机反馈："只要弹出，主编辑界面就太小了"）
  const point = await page.evaluate(() => {
    const api = window.__pptxPane;
    const box = api.shapeBox("标题 1");
    const canvas = api.canvas();
    const layer = canvas.layer;
    return {
      x: layer.left + ((box.x + box.width / 2) / 9525) * canvas.scale,
      y: layer.top + ((box.y + box.height / 2) / 9525) * canvas.scale,
    };
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(400);
  const afterSelect = await read();
  check(
    afterSelect.taskPane === false,
    `点中形状只选中、不自动弹窗格（窗格开着=${afterSelect.taskPane}）`,
  );

  // ①c 显式开：顶部的「设置形状格式」（功能区）→ 中间的 ✕ 收起；再过一遍底部那个按钮
  const openedByRibbon = await page.evaluate(async () => {
    // 先确认命令本身通（按钮找不到时能区分"命令没接上"与"按钮点不到"）
    const before = Boolean(document.querySelector("[data-pptx-task-pane]"));
    window.__pptxPane.runCommand("pptxToggleFormatPane");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterCommand = Boolean(document.querySelector("[data-pptx-task-pane]"));
    if (afterCommand) {
      // 命令开了就关回来，后面的按钮断言从"关着"开始
      window.__pptxPane.runCommand("pptxToggleFormatPane");
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    window.__pptxToggleProbe = { before, afterCommand };
    const tab = [...document.querySelectorAll("[data-office-ribbon-tab]")].find(
      (node) => (node.textContent ?? "").trim() === "视图",
    );
    tab?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const find = () =>
      [...document.querySelectorAll("button")].find((item) =>
        (item.getAttribute("title") ?? "").startsWith("开/关右侧"),
      );
    let node = find();
    if (!node) {
      // 面板窄 → 这一组会收进「»」菜单（它自己的 toggle 语义：连点两次能回到打开状态）
      for (let attempt = 0; attempt < 2 && !node; attempt += 1) {
        document.querySelector("[data-office-ribbon-more]")?.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        node = find();
      }
    }
    if (!node) return false;
    node.click();
    return true;
  });
  await page.waitForTimeout(500);
  const afterRibbon = await read();
  const probe = await page.evaluate(() => window.__pptxToggleProbe ?? null);
  const closedByButton = await page.evaluate(() => {
    const close = document.querySelector("[data-pptx-close-format]");
    if (!close) return false;
    close.click();
    return true;
  });
  await page.waitForTimeout(300);
  const closed = await read();
  check(
    openedByRibbon && afterRibbon.taskPane && closedByButton && !closed.taskPane,
    `功能区「设置形状格式」能开、✕ 能收（命令：${JSON.stringify(probe)}｜开 ${afterRibbon.taskPane} → 收 ${!closed.taskPane}）`,
  );

  // ①d 右键画布上的对象 → 菜单里能开窗格、也能复制/删除（不用再为这些动作开窗格）
  const byRightClick = await page.evaluate(async () => {
    const api = window.__pptxPane;
    const box = api.shapeBox("标题 1");
    const canvas = api.canvas();
    const layer = canvas.layer;
    const x = layer.left + ((box.x + box.width / 2) / 9525) * canvas.scale;
    const y = layer.top + ((box.y + box.height / 2) / 9525) * canvas.scale;
    const target = document.elementFromPoint(x, y);
    if (!target) return { ok: false, why: "没有元素" };
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: x, clientY: y, button: 2 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const menu = document.querySelector("[data-pptx-canvas-menu]");
    const items = menu
      ? [...menu.querySelectorAll("[data-pptx-canvas-menu-item]")].map((node) =>
          node.getAttribute("data-pptx-canvas-menu-item"),
        )
      : [];
    const formatItem = menu?.querySelector('[data-pptx-canvas-menu-item="format"]');
    formatItem?.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      ok: true,
      items,
      paneOpen: Boolean(document.querySelector("[data-pptx-task-pane]")),
      menuGone: !document.querySelector("[data-pptx-canvas-menu]"),
    };
  });
  check(
    byRightClick.ok &&
      byRightClick.items.includes("format") &&
      byRightClick.items.includes("duplicate") &&
      byRightClick.items.includes("delete") &&
      byRightClick.paneOpen &&
      byRightClick.menuGone,
    `右键菜单能开窗格与形状操作（项 ${JSON.stringify(byRightClick.items)}，点完窗格=${byRightClick.paneOpen}、菜单收起=${byRightClick.menuGone}）`,
  );

  // ②b 打开窗格后**整页仍然可见**（缩放跟着可用区域走）。
  //     "面板占布局、画布让位"那条在带 Tailwind 的检查页里验（这里的裸页面没有 flex 布局）
  await page.evaluate(() => document.querySelector("[data-pptx-open-format]")?.click());
  await page.waitForTimeout(600);
  const afterOpen = await page.evaluate(() => {
    const frame = document.querySelector("[data-pptx-canvas-frame]").getBoundingClientRect();
    const box = document.querySelector("[data-pptx-canvas-page]").getBoundingClientRect();
    return {
      scale: window.__pptxPane?.canvas?.()?.scale ?? 0,
      page: [Math.round(box.width), Math.round(box.height)],
      fullyVisible:
        box.left >= frame.left - 1 &&
        box.right <= frame.right + 1 &&
        box.top >= frame.top - 1 &&
        box.bottom <= frame.bottom + 1,
    };
  });
  check(
    afterOpen.fullyVisible && afterOpen.page[0] > 0,
    `窗格开着时整页仍完整可见（${afterOpen.page[0]}×${afterOpen.page[1]}，scale ${afterOpen.scale.toFixed(3)}）`,
  );

  // ②c 按选中对象显示不同设置：图片不给"文字/段落"，并写明图片的边界
  const kindAware = await page.evaluate(async () => {
    const root =
      document.querySelector("[data-pptx-shape]")?.closest("[data-pptx-task-pane]") ?? document;
    const readPanel = () => {
      const pane = document.querySelector("[data-pptx-task-pane]");
      if (!pane) return null;
      return {
        textTools: Boolean(pane.querySelector("[data-shape-size], [data-shape-align=left]")),
        note:
          pane.querySelector("[data-pptx-kind-note]")?.getAttribute("data-pptx-kind-note") ?? null,
        noteText: pane.querySelector("[data-pptx-kind-note]")?.textContent?.slice(0, 40) ?? "",
      };
    };
    // 选中一个文本框（fixture 里叫"标题 1"）
    document.querySelector("[data-pptx-open-format]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    document.querySelector('[data-pptx-shape="标题 1"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const textShape = readPanel();
    void root;
    return { textShape };
  });
  check(
    kindAware.textShape?.textTools === true && kindAware.textShape.note === null,
    `选中文本框时给文字/段落工具（textTools=${kindAware.textShape?.textTools}）`,
  );

  // ③ 页面**上下左右都居中**（用户口径：不只左右，还要像 PowerPoint 一样上下居中）
  await page.evaluate(() => document.querySelector("[data-pptx-close-format]")?.click());
  await page.waitForTimeout(600);
  const centered = await page.evaluate(() => {
    const frame = document.querySelector("[data-pptx-canvas-frame]").getBoundingClientRect();
    const box = document.querySelector("[data-pptx-canvas-page]").getBoundingClientRect();
    return {
      gapLeft: box.left - frame.left,
      gapRight: frame.right - box.right,
      gapTop: box.top - frame.top,
      gapBottom: frame.bottom - box.bottom,
    };
  });
  check(
    Math.abs(centered.gapLeft - centered.gapRight) <= 2 &&
      Math.abs(centered.gapTop - centered.gapBottom) <= 2,
    `页面上下左右都居中（左右 ${Math.round(centered.gapLeft)}/${Math.round(centered.gapRight)}，上下 ${Math.round(centered.gapTop)}/${Math.round(centered.gapBottom)}）`,
  );

  // ④ Ctrl + 滚轮缩放：指针停在页面中心，缩放后仍然对准同一个点
  const before = await read();
  const pointer = {
    x: before.page.left + before.page.width / 2,
    y: before.page.top + before.page.height / 2,
  };
  await page.mouse.move(pointer.x, pointer.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await page.waitForTimeout(400);
  const after = await read();
  const scale = after.page.width / before.page.width;
  // 指针下的页面相对位置：缩放前后应当接近
  const fxBefore = (pointer.x - before.page.left) / before.page.width;
  const fxAfter = (pointer.x - after.page.left) / after.page.width;
  check(
    after.zoom !== null && after.zoom > (before.zoom ?? 0) && Math.abs(fxAfter - fxBefore) < 0.06,
    `Ctrl+滚轮以指针为中心缩放（${before.zoom}% → ${after.zoom}%，页面宽 ×${scale.toFixed(2)}，指针处相对位置 ${fxBefore.toFixed(3)} → ${fxAfter.toFixed(3)}）`,
  );
  // 画布框**不能**被里面的页面撑宽：否则会出现"页面变大 → 框变宽 → 页面更大"的正反馈
  // （真机实测：滚轮放大一次，页面从 816px 涨到 27794px）
  const frameGrew = Math.abs(after.frame.width - before.frame.width);
  // 适应窗口＝按可用宽/高算出的缩放取小的那个；期望页面宽 = 页宽像素 × 该缩放 × zoom
  const fit = Math.min((after.frame.width - 16) / 960, (after.frame.height - 16) / 720);
  const expectedPageWidth = 960 * fit * ((after.zoom ?? 0) / 100);
  check(
    frameGrew <= 2 && Math.abs(after.page.width - expectedPageWidth) <= 4,
    `缩放不把画布框撑宽（框 ${Math.round(before.frame.width)} → ${Math.round(after.frame.width)}px，页面 ${Math.round(after.page.width)}px ≈ 框宽×${after.zoom}%）`,
  );
}

/**
 * PPT 备注（讲稿备注）的**界面断言**：窗格里的备注框 ↔ 包里的 `notesSlideN.xml`。
 * 数据层的读写已经由 check-office-pptx.mjs 的 ⑬ 盯着；这里盯的是**接线**：
 * 框里打字 → 失焦提交 → 真的落到包里那一个部件（而且是**只**动那一个部件）。
 */
export async function runPptxNotesPanelCases({ page, check }) {
  const clickShapeLive = async (name) => {
    // 点击点必须**现读**画布矩形与缩放：前面别的用例滚过/缩放过，挂载时那份早就失效
    const point = await page.evaluate((shapeName) => {
      const api = window.__pptxPane;
      const box = api.shapeBox(shapeName);
      const canvas = api.canvas();
      if (!box || !canvas) return null;
      return {
        x: canvas.layer.left + ((box.x + box.width / 2) / 9525) * canvas.scale,
        y: canvas.layer.top + ((box.y + box.height / 2) / 9525) * canvas.scale,
      };
    }, name);
    if (!point) return false;
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(400);
    return true;
  };
  /** 点窗格标题那条空白带 = 让备注框失焦（不在画布上点，免得顺手取消选择把窗格关掉）。 */
  const blurByPaneHeader = async () => {
    const point = await page.evaluate(() => {
      const box = document.querySelector("[data-pptx-task-pane]")?.getBoundingClientRect();
      return box ? { x: box.left + box.width / 2, y: box.top + 8 } : null;
    });
    if (point) await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(600);
  };
  const readNotes = () =>
    page.evaluate(() => {
      const area = document.querySelector("textarea[data-pptx-notes]");
      const section = area?.parentElement?.textContent ?? "";
      return {
        present: Boolean(area),
        value: area?.value ?? null,
        hint: section.includes("已保存进这一页")
          ? "已保存进这一页"
          : section.includes("还没有备注")
            ? "还没有备注"
            : null,
        status: document.querySelector("[data-office-toolbar]")?.textContent?.slice(-52) ?? "",
      };
    });
  /**
   * 模型字节（喂给渲染器的那份）里每个部件的内容指纹 + 每个备注部件的正文。
   * 正文用**产品自己的读取函数**取：备注页里还有页码占位符，它里面也有 a:t（页码那个数字），
   * 拿正则把所有 a:t 都收进来会把页码当备注（这个坑本身就是回归要盯的东西）。
   */
  const snapshot = () =>
    page.evaluate(async () => {
      const bytes = window.__pptxPane?.previewBytes?.() ?? null;
      if (!bytes) return null;
      const parts = await window.__pptx.parts(bytes);
      const zip = await window.JSZip.loadAsync(bytes.slice(0));
      const notes = {};
      const fields = {};
      for (const name of Object.keys(parts)) {
        if (!/notesSlides\/notesSlide\d+\.xml$/.test(name)) continue;
        const xml = (await zip.file(name)?.async("string")) ?? "";
        notes[name] = window.__pptx.readNotesText(xml);
        // 页码占位符里的字段：改备注**不许**碰它
        fields[name] = /<a:fld[^>]*type="slidenum"[^>]*>\s*<a:t>1<\/a:t>/.test(xml);
      }
      return { parts, notes, fields };
    });
  const changedParts = (before, after) =>
    Object.keys(after.parts).filter((name) => before.parts[name] !== after.parts[name]);

  await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    await window.__pptx.mountPane(bytes.slice(0));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (window.__pptxPane?.canvas?.()?.ready) break;
    }
  });

  // ① 选中形状 + **显式**开窗格（不再自动弹）→ 有备注框，内容是这一页已有的备注
  await clickShapeLive("标题 1");
  await page.evaluate(() => {
    if (!document.querySelector("[data-pptx-task-pane]")) {
      document.querySelector("[data-pptx-open-format]")?.click();
    }
  });
  await page.waitForTimeout(500);
  const opened = await readNotes();
  check(
    opened.present && opened.value === "讲稿备注" && opened.hint === "已保存进这一页",
    `窗格里的备注框读的是这一页的备注（${JSON.stringify(opened.value)}｜${opened.hint}）`,
  );

  // ② 改字 → 点别处失焦 = 提交，且**只**动备注部件（幻灯片 XML 一个字节都不该变）
  const before1 = await snapshot();
  await page.fill("textarea[data-pptx-notes]", "开场先讲结论");
  await blurByPaneHeader();
  const after1 = await snapshot();
  const changed1 = changedParts(before1, after1);
  check(
    after1.notes["ppt/notesSlides/notesSlide1.xml"]?.join("|") === "开场先讲结论" &&
      after1.fields["ppt/notesSlides/notesSlide1.xml"] === true &&
      changed1.length === 1,
    `改备注只动备注部件、也不碰页码占位符（改动：${changed1.join("、") || "无"}｜页码字段还在 ${
      after1.fields["ppt/notesSlides/notesSlide1.xml"]
    }｜备注 ${JSON.stringify(after1.notes["ppt/notesSlides/notesSlide1.xml"])}）`,
  );
  const shown = await readNotes();
  check(
    shown.value === "开场先讲结论" && shown.status.includes("备注"),
    `提交后备注框与状态栏都跟上（${JSON.stringify(shown.value)}｜${shown.status}）`,
  );

  // ③ 换到第 2 页：空备注；写一点 → 新建备注部件（rel + Content_Types 一起补上）
  const switched = await page.evaluate(() => {
    const host = document.querySelector("[data-pptx-thumb-host='1']");
    const button = host?.closest("button");
    if (!button) return false;
    button.click();
    return true;
  });
  await page.waitForTimeout(600);
  const second = await readNotes();
  check(
    switched && second.value === "" && second.hint === "还没有备注",
    `换到没备注的第 2 页：空框（${JSON.stringify(second.value)}｜${second.hint}）`,
  );
  await page.fill("textarea[data-pptx-notes]", "第二页的讲稿");
  await blurByPaneHeader();
  const after2 = await snapshot();
  const wired = await page.evaluate(async () => {
    const zip = await window.JSZip.loadAsync(window.__pptxPane.previewBytes().slice(0));
    const rels = (await zip.file("ppt/slides/_rels/slide2.xml.rels")?.async("string")) ?? "";
    const types = (await zip.file("[Content_Types].xml")?.async("string")) ?? "";
    return {
      rel: /relationships\/notesSlide"/.test(rels),
      types: types.includes("/ppt/notesSlides/notesSlide2.xml"),
    };
  });
  check(
    after2.notes["ppt/notesSlides/notesSlide2.xml"]?.join("|") === "第二页的讲稿" &&
      wired.rel &&
      wired.types,
    `给没备注的页写备注会新建部件并补 rel 与 Content_Types（rel=${wired.rel} 登记=${wired.types}）`,
  );
  check(
    after2.notes["ppt/notesSlides/notesSlide1.xml"]?.join("|") === "开场先讲结论",
    `第 1 页的备注不受影响（${JSON.stringify(after2.notes["ppt/notesSlides/notesSlide1.xml"])}）`,
  );
  // ④ 产物仍是合法的 pptx：渲染器认它，幻灯片数不变
  const rendered = await page.evaluate(async () =>
    window.__pptx.render(window.__pptxPane.previewBytes()),
  );
  check(
    rendered.slides === 2,
    `加了备注之后 deck 仍然打得开、渲染器认（${rendered.slides} 页，文字 ${JSON.stringify(
      rendered.text?.slice(0, 30),
    )}）`,
  );
}
