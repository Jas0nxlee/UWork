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
}
