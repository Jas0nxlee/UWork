/**
 * PPT 画布级编辑的**界面断言**（点选 / 拖动 / 拉角缩放）。
 *
 * 这里必须用真的鼠标事件：画布的换算（EMU ↔ 显示像素）与命中测试只有真点下去才验得出来。
 *
 * 换算写成测试自己的式子，**不借产品里的常量**：渲染器给的是 96 dpi 像素（9144000 EMU 的一页
 * = 960 px），所以 1 px = 9525 EMU；显示位置 = 图层左上角 + 形状几何(EMU) ÷ 9525 × scale。
 * 两边要一起错才会"通过"，所以 9525 在这里再写一遍。
 */
const EMU_PER_PX = 9525;
const POSITION_TOLERANCE_PX = 3;

export async function runPptxCanvasCases({ page, check }) {
  const readCanvas = () => page.evaluate(() => window.__pptxPane?.canvas?.() ?? null);
  const readBox = (name) =>
    page.evaluate((shapeName) => window.__pptxPane?.shapeBox?.(shapeName) ?? null, name);

  const mounted = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    await window.__pptx.mountPane(bytes.slice(0));
    // 渲染器要解压 + 建 DOM，给它一点时间
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const canvas = window.__pptxPane?.canvas?.();
      if (canvas?.ready) {
        document.querySelector("[data-pptx-canvas-frame]")?.scrollIntoView({ block: "center" });
        return canvas;
      }
    }
    return window.__pptxPane?.canvas?.() ?? null;
  });
  check(
    Boolean(mounted?.ready) && (mounted?.renderedNodes ?? 0) > 0,
    `画布把这一页渲染出来了（${mounted?.renderedNodes ?? 0} 个节点）`,
  );
  check(
    mounted?.scale > 0 && mounted?.pageWidth === 9144000,
    `画布把渲染器的像素页换算成 EMU（页宽 ${mounted?.pageWidth ?? 0}，scale=${mounted?.scale}）`,
  );

  // ① 点形状 → 选中（选框 + 四个手柄）
  const titleBox = await readBox("标题 1");
  const layer = (await readCanvas())?.layer;
  const center = (box) => ({
    x: layer.left + ((box.x + box.width / 2) / EMU_PER_PX) * mounted.scale,
    y: layer.top + ((box.y + box.height / 2) / EMU_PER_PX) * mounted.scale,
  });
  const titlePoint = center(titleBox);
  await page.mouse.click(titlePoint.x, titlePoint.y);
  await page.waitForTimeout(200);
  const selected = await readCanvas();
  check(
    selected?.selected === "标题 1" && selected?.handles === 4,
    `在画布上点中形状就选中（选中「${selected?.selected}」，${selected?.handles} 个手柄）`,
  );

  // ② 拖动：XML 里的 a:off 要跟着动，且画布重画（渲染的 DOM 换了一棵）
  await page.evaluate(() => {
    window.__canvasHostChild = document.querySelector("[data-pptx-canvas-host]")?.firstElementChild;
  });
  const dragX = 60;
  const dragY = 24;
  await page.mouse.move(titlePoint.x, titlePoint.y);
  await page.mouse.down();
  await page.mouse.move(titlePoint.x + dragX, titlePoint.y + dragY, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const movedBox = await readBox("标题 1");
  const expectedDx = (dragX / mounted.scale) * EMU_PER_PX;
  const expectedDy = (dragY / mounted.scale) * EMU_PER_PX;
  const tolerance = (POSITION_TOLERANCE_PX / mounted.scale) * EMU_PER_PX;
  check(
    Math.abs(movedBox.x - titleBox.x - expectedDx) < tolerance &&
      Math.abs(movedBox.y - titleBox.y - expectedDy) < tolerance,
    `拖 ${dragX}px 后位置落到 XML（Δx=${Math.round(movedBox.x - titleBox.x)} EMU，应约 ${Math.round(expectedDx)}）`,
  );
  check(
    movedBox.width === titleBox.width && movedBox.height === titleBox.height,
    `拖动不改大小（${movedBox.width}×${movedBox.height} 未变）`,
  );
  const rerendered = await page.evaluate(() => {
    const host = document.querySelector("[data-pptx-canvas-host]");
    const before = window.__canvasHostChild;
    window.__canvasHostChild = null;
    return { had: Boolean(before), changed: host?.firstElementChild !== before };
  });
  check(
    rerendered.had && rerendered.changed,
    "改动之后画布重画了（喂给渲染器的是编辑后的字节，不是原始文件）",
  );

  // ③ 拉右下角手柄 → 宽高变化，左上角不动
  const handlePoint = await page.evaluate(() => {
    const node = document.querySelector("[data-pptx-canvas-handle='se']");
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const growX = 42;
  const growY = 30;
  await page.mouse.move(handlePoint.x, handlePoint.y);
  await page.mouse.down();
  await page.mouse.move(handlePoint.x + growX, handlePoint.y + growY, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const resized = await readBox("标题 1");
  check(
    Math.abs(resized.width - movedBox.width - (growX / mounted.scale) * EMU_PER_PX) < tolerance &&
      Math.abs(resized.height - movedBox.height - (growY / mounted.scale) * EMU_PER_PX) < tolerance,
    `拉角缩放落到 XML（${movedBox.width}×${movedBox.height} → ${resized.width}×${resized.height} EMU）`,
  );
  check(
    resized.x === movedBox.x && resized.y === movedBox.y,
    `拉右下角不动左上角（x=${resized.x}）`,
  );

  // ④ 点空白处 → 取消选择（空白处就是"页面里没有任何形状"的地方）
  const emptyX = layer.left + layer.width * 0.82;
  const emptyY = layer.top + layer.height * 0.82;
  await page.mouse.click(emptyX, emptyY);
  await page.waitForTimeout(200);
  const cleared = await readCanvas();
  check(
    cleared?.selected === null && cleared?.handles === 0,
    "点空白处取消选择（选框与手柄都收起来）",
  );

  // ⑤ 双击形状 → 焦点落到它的文本框（就地改字的入口）
  const titleAgain = center(resized);
  await page.mouse.dblclick(titleAgain.x, titleAgain.y);
  await page.waitForTimeout(300);
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute("data-pptx-block") ?? null,
  );
  check(
    typeof focused === "string" && focused.includes("#0"),
    `双击形状把焦点给了它的文本框（${focused}）`,
  );
}
