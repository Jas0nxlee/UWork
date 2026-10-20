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
  const committed = await page.evaluate(() => {
    const xml = window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "";
    const blocks = [...document.querySelectorAll("[data-pptx-block]")].map((node) => node.value);
    return {
      editorGone: !document.querySelector("[data-pptx-text-editor]"),
      cellIndex: window.__pptx.cellBlockIndexOf(xml, "表格 1", 0, 0),
      blocks,
      size: window.__pptx.tableSizeOf(xml, "表格 1"),
    };
  });
  check(
    committed.editorGone &&
      committed.blocks.some((value) => String(value).includes("格子里改的字")) &&
      committed.size?.rows === 1 &&
      committed.size?.cols === 1,
    `提交后这一格的字变了、表格结构没变（1×1；块 ${JSON.stringify(committed.blocks).slice(0, 48)}）`,
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
