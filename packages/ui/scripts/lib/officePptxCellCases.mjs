/**
 * **表格单元格的界面断言**：点格子（出现细框）、双击就地改字（编辑层盖在**那一格**上）、
 * 提交后只有那一格的文字变了。
 *
 * 为什么单独一遍：单元格的命中与编辑层的位置都依赖渲染器给出的"单元格绝对框"，
 * 数据层（XML 字符串）测不出来——必须真的点。
 */
export async function runPptxCellCases({ page, check }) {
  const wait = (ms) => page.waitForTimeout(ms);
  const mounted = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    await window.__pptx.mountPane(bytes.slice(0));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (window.__pptxPane?.canvas?.()?.ready) break;
    }
    return { ready: Boolean(window.__pptxPane?.canvas?.()?.ready) };
  });
  check(mounted.ready, "编辑位起来了（单元格用例的前提）");

  // 表格 1 在 fixture 里是 1×1：单元格范围 == 表格范围，所以"表中心"就是"格中心"
  const tableCenter = await page.evaluate(() => {
    const canvas = window.__pptxPane.canvas();
    const box = window.__pptxPane.shapeBox("表格 1");
    return {
      box,
      x: canvas.layer.left + ((box.x + box.width / 2) / 9525) * canvas.scale,
      y: canvas.layer.top + ((box.y + box.height / 2) / 9525) * canvas.scale,
      scale: canvas.scale,
    };
  });

  // ① 点一格：出现单元格细框
  await page.mouse.click(tableCenter.x, tableCenter.y);
  await wait(500);
  const selected = await page.evaluate(() => {
    const outline = document.querySelector("[data-pptx-canvas-cell]");
    return { outline: outline?.getAttribute("data-pptx-canvas-cell") ?? null };
  });
  check(selected.outline === "表格 1#0,0", `点表格里的格子会选中它（细框 ${selected.outline}）`);

  // ② 双击那一格：编辑层盖在格子上，内容是这一格的字
  await page.mouse.dblclick(tableCenter.x, tableCenter.y);
  await wait(600);
  const editing = await page.evaluate(() => {
    const editor = document.querySelector("[data-pptx-text-editor]");
    if (!editor) return null;
    const rect = editor.getBoundingClientRect();
    return { value: editor.value, rect: { left: rect.left, top: rect.top, width: rect.width } };
  });
  check(
    editing !== null && editing.value.includes("单元格文字"),
    `双击格子就地改字（编辑层里是这一格的字：${JSON.stringify(editing?.value ?? null)}）`,
  );
  // 编辑层与格子**同起点**、不小于格宽（编辑器有 60px 的最小宽度，窄格子会被撑宽一点——
  // 那是为了能打字，不是错位）
  const cellWidth = (tableCenter.box.width / 9525) * tableCenter.scale;
  check(
    editing !== null &&
      editing.rect.width >= cellWidth - 2 &&
      Math.abs(editing.rect.left - (tableCenter.x - cellWidth / 2)) < 12,
    `编辑层与格子对齐（左边 ${Math.round(editing?.rect.left ?? -1)} ≈ 格左 ${Math.round(tableCenter.x - cellWidth / 2)}；宽 ${Math.round(editing?.rect.width ?? -1)} ≥ 格宽 ${Math.round(cellWidth)}）`,
  );

  // ③ 改字提交：只有这一格的文字变了
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("格子里改的字");
  await page.keyboard.press("Meta+Enter");
  await wait(900);
  const committed = await page.evaluate(async () => {
    // 文字是"草稿"，要读**合成后的预览字节**（`modelXml` 是部件原文）
    const bytes = window.__pptxPane.previewBytes();
    const zip = bytes ? await window.JSZip.loadAsync(bytes.slice(0)) : null;
    const xml = zip ? ((await zip.file("ppt/slides/slide1.xml")?.async("string")) ?? "") : "";
    return {
      editorGone: !document.querySelector("[data-pptx-text-editor]"),
      inXml: xml.includes("格子里改的字"),
      size: window.__pptx.tableSizeOf(xml, "表格 1") ?? null ?? { rows: null, cols: null },
    };
  });
  check(
    committed.editorGone &&
      committed.inXml &&
      committed.size?.rows === 1 &&
      committed.size?.cols === 1,
    `提交后这一格的字变了、表格结构没变（1×1；合成后的这一页里有改的字=${committed.inXml}）`,
  );

  // ⑤ 在表格里**拖出一片**单元格（PowerPoint 的多选手势）→ 功能区「合并单元格」并成一片
  // fixture 的表格是 1×1，先插一张 3×3（用调试口子直接跑"插入表格"那条命令）
  const inserted = await page.evaluate(async () => {
    window.__pptxPane.runCommand("executeInsertTable", [3, 3]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const names = window.__pptxPane.shapeNames().filter((name) => name.startsWith("表格 "));
    const name = names[names.length - 1] ?? null;
    const canvas = window.__pptxPane.canvas();
    const box = name ? window.__pptxPane.shapeBox(name) : null;
    return { name, box, canvas };
  });
  check(
    Boolean(inserted.name) && inserted.box?.width > 0,
    `插一张 3×3 用来试多选（${inserted.name}，框 ${Math.round(inserted.box?.width ?? 0)}×${Math.round(
      inserted.box?.height ?? 0,
    )} EMU）`,
  );
  const pane = inserted.canvas;
  /** 单元格中心（插进来的表格是均分的，直接按 3×3 均分算；点/拖都按画布现读的矩形） */
  const cellPoint = async (row, col) => {
    const live = await page.evaluate((name) => {
      const canvas = window.__pptxPane.canvas();
      return { canvas, box: window.__pptxPane.shapeBox(name) };
    }, inserted.name);
    const layer = live.canvas.layer;
    const x = live.box.x + (live.box.width * (col + 0.5)) / 3;
    const y = live.box.y + (live.box.height * (row + 0.5)) / 3;
    return {
      x: layer.left + (x / 9525) * live.canvas.scale,
      y: layer.top + (y / 9525) * live.canvas.scale,
    };
  };
  const from = await cellPoint(0, 0);
  const to = await cellPoint(1, 1);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  await wait(500);
  const picked = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("[data-pptx-canvas-cell]")].map((node) =>
      node.getAttribute("data-pptx-canvas-cell"),
    );
    return { cells, table: document.querySelector("[data-pptx-task-pane]") ? "open" : "closed" };
  });
  check(
    picked.cells.length === 4 &&
      picked.cells.includes(`${inserted.name}#0,0`) &&
      picked.cells.includes(`${inserted.name}#1,1`),
    `在表格里拖一下选中一片 2×2（${picked.cells.length} 格：${picked.cells.join("、")}）`,
  );

  // 拖出来的这一片交给「合并单元格」→ 锚点拿到 gridSpan/rowSpan
  const merged = await page.evaluate(async (name) => {
    const tab = [...document.querySelectorAll("[data-office-ribbon-tab]")].find(
      (node) => (node.textContent ?? "").trim() === "表格",
    );
    tab?.click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const find = () =>
      [...document.querySelectorAll("button")].find((node) =>
        (node.getAttribute("title") ?? "").includes("把选中的一片单元格合并"),
      );
    let node = find();
    if (!node) {
      document.querySelector("[data-office-ribbon-more]")?.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      node = find();
    }
    if (!node) return { clicked: false };
    node.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const xml = window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "";
    return {
      clicked: true,
      name,
      span: /<a:tc gridSpan="2" rowSpan="2">|<a:tc rowSpan="2" gridSpan="2">/.test(xml),
      marks: /hMerge="1"/.test(xml) && /vMerge="1"/.test(xml),
      status: document.querySelector("[data-office-toolbar]")?.textContent?.slice(-42) ?? "",
    };
  }, inserted.name);
  check(
    merged.clicked && merged.span && merged.marks,
    `「合并单元格」把拖出来的 2×2 并成一格（span=${merged.span} 覆盖标记=${merged.marks}｜${merged.status}）`,
  );

  // 对齐方式：垂直居中 + 水平居中（两条命令都要落到 XML 上）
  const aligned = await page.evaluate(async (name) => {
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
    const vertical = await click("单元格内容垂直居中");
    const horizontal = await click("单元格文字水平居中");
    const xml = window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "";
    return {
      vertical,
      horizontal,
      anchor: /anchor="ctr"/.test(xml),
      align: /<a:pPr algn="ctr"\/>/.test(xml),
      name,
    };
  }, inserted.name);
  check(
    aligned.vertical && aligned.horizontal && aligned.anchor && aligned.align,
    `「对齐方式」两个方向都落到 XML（垂直 a:tcPr@anchor=${aligned.anchor} 水平段落 algn=${aligned.align}）`,
  );

  // ⑤a2 表格**能拖动**：抓"边框带"（表边往里几像素）拖 → 整张表跟着走、大小不变；
  //      在格子中间拖 → 选一片单元格、**不动几何**（真机反馈过"表格无法拖动"）
  const beforeDrag = await page.evaluate(() => {
    const canvas = window.__pptxPane.canvas();
    return { box: window.__pptxPane.shapeBox("表格 10"), scale: canvas.scale, layer: canvas.layer };
  });
  // 左边界往里 2px（在边框带里；带宽 = min(6, 格子尺寸/3)）
  const grabPoint = {
    x: beforeDrag.layer.left + (beforeDrag.box.x / 9525) * beforeDrag.scale + 2,
    y:
      beforeDrag.layer.top +
      ((beforeDrag.box.y + beforeDrag.box.height / 2) / 9525) * beforeDrag.scale,
  };
  await page.mouse.move(grabPoint.x, grabPoint.y);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.move(grabPoint.x + 40, grabPoint.y + 16, { steps: 8 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(700);
  const afterDrag = await page.evaluate(() => ({
    box: window.__pptxPane.shapeBox("表格 10"),
    selected: window.__pptxPane.canvas()?.selected ?? null,
    cells: document.querySelectorAll("[data-pptx-canvas-cell]").length,
  }));
  const movedDx = afterDrag.box.x - beforeDrag.box.x;
  check(
    Math.abs(movedDx - (40 / beforeDrag.scale) * 9525) < (4 / beforeDrag.scale) * 9525 &&
      afterDrag.box.width === beforeDrag.box.width &&
      afterDrag.box.height === beforeDrag.box.height,
    `抓表格**边框**能拖动整张表（Δx=${Math.round(movedDx)} EMU，应约 ${Math.round((40 / beforeDrag.scale) * 9525)}；大小不变 ${
      afterDrag.box.width === beforeDrag.box.width
    }）`,
  );

  // ⑤b 画布上**看得见网格线**：插进来的表，渲染出来的 td 计算边框宽度必须 > 0
  //     （用户口径："表格没有边框？"——XML 里有 a:lnL 不等于画得出来，必须看渲染结果。
  //      注意页上还有 fixture 那张**本来就没边框**的表，所以按"哪张表整张都有线"来判，别数第一格）
  const grid = await page.evaluate(() => {
    const xml = window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "";
    const names = window.__pptxPane.shapeNames().filter((name) => name.startsWith("表格 "));
    const name = names[names.length - 1] ?? null;
    const tables = [...document.querySelectorAll("[data-pptx-canvas-host] table")].map((table) => {
      const cells = [...table.querySelectorAll("td")];
      const edges = (cell) =>
        ["Top", "Right", "Bottom", "Left"].every(
          (side) => Number.parseFloat(getComputedStyle(cell)[`border${side}Width`]) > 0,
        );
      return { cells: cells.length, gridded: cells.filter(edges).length };
    });
    return { name, on: name ? window.__pptx.tableGridOn(xml, name) : false, tables };
  });
  check(
    grid.on && grid.tables.some((table) => table.cells > 0 && table.cells === table.gridded),
    `画布上的表格真的画出了网格线（XML 有网格=${grid.on}；各表 [格数/带框格数] ${grid.tables
      .map((t) => `${t.cells}/${t.gridded}`)
      .join("、")}）`,
  );
  // ⑤c 右栏的「表格设置 → 网格线」开关（窄面板下功能区那一组会收进二级菜单，
  //     用户实际会从右栏点）：能开、能关，并且整张表跟着变
  const paneGrid = await page.evaluate(async () => {
    // 回到 fixture 那张表（它自带没有边框），确认开关默认是关的
    document.querySelector('[data-pptx-shape="表格 1"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const box = document.querySelector("input[data-pptx-table-grid]");
    if (!box) return { present: false };
    const initialState = box.checked;
    box.click();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const xml = window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "";
    const start = xml.indexOf("<a:tbl");
    const slice = xml.slice(start, xml.indexOf("</a:tbl>", start));
    const size = window.__pptx.tableSizeOf(xml, "表格 1") ?? { rows: 0, cols: 0 };
    const afterOn = {
      checked: document.querySelector("input[data-pptx-table-grid]")?.checked ?? null,
      lines: (slice.match(/<a:ln[LRTB][ >]/g) ?? []).length,
      // 每格四边：这张表几格就该有几 × 4 条线
      expected: size.rows * size.cols * 4,
      grid: window.__pptx.tableGridOn(xml, "表格 1"),
    };
    document.querySelector("input[data-pptx-table-grid]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const xml2 = window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "";
    const start2 = xml2.indexOf("<a:tbl");
    const off = !/<a:ln[LRTB][ >]/.test(xml2.slice(start2, xml2.indexOf("</a:tbl>", start2)));
    return { present: true, initialState, afterOn, off };
  });
  check(
    paneGrid.present &&
      paneGrid.initialState === false &&
      paneGrid.afterOn.checked === true &&
      paneGrid.afterOn.grid &&
      paneGrid.afterOn.lines === paneGrid.afterOn.expected &&
      paneGrid.off,
    `右栏「表格设置」的网格线开关能开关整张表（初始 ${paneGrid.initialState} → 开：${paneGrid.afterOn.lines}/${paneGrid.afterOn.expected} 条线、开关态 ${
      paneGrid.afterOn.checked
    } → 关掉 ${paneGrid.off}）`,
  );

  // ⑥ **改了非文字的东西也要能保存**（真机实测的 bug：合并一片单元格 + 写备注之后点保存，
  //    被"没有检测到文字改动，未写盘"挡掉——用户改了却没写盘）。
  //    这里点的是面板里的「保存到文件」，断言"真的调了写盘，而且写进去的字节里有合并标记"。
  const saved = await page.evaluate(async () => {
    const before = window.__pptxWrites?.length ?? 0;
    const button = [...document.querySelectorAll("button")].find(
      (node) => (node.textContent || "").trim() === "保存到文件",
    );
    if (!button) return { clicked: false };
    button.click();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if ((window.__pptxWrites?.length ?? 0) > before) break;
    }
    const last = window.__pptxWrites?.[window.__pptxWrites.length - 1];
    const bytes = last ? Uint8Array.from(atob(last.dataBase64), (ch) => ch.charCodeAt(0)) : null;
    const text = bytes ? new TextDecoder().decode(bytes) : "";
    const zip = bytes ? await window.JSZip.loadAsync(bytes.buffer.slice(0)) : null;
    const slide = zip ? ((await zip.file("ppt/slides/slide1.xml")?.async("string")) ?? "") : "";
    return {
      clicked: true,
      writes: (window.__pptxWrites?.length ?? 0) - before,
      merged: /gridSpan="2"/.test(slide) && /hMerge="1"/.test(slide),
      status: document.querySelector("[data-office-toolbar]")?.textContent?.slice(-46) ?? "",
      hasZip: Boolean(zip),
      raw: text.length,
    };
  });
  check(
    saved.clicked && saved.writes === 1 && saved.merged,
    `非文字改动（合并单元格）也真的写盘，且写进去的字节里有合并标记（写盘 ${saved.writes} 次｜${
      saved.merged
    }｜${saved.status}）`,
  );
}
