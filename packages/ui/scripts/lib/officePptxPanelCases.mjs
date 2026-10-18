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

  // ② 在画布上点中形状 → 窗格自动打开；点 ✕ → 收起
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
  const opened = await read();
  const closedByButton = await page.evaluate(() => {
    const close = document.querySelector("[data-pptx-close-format]");
    if (!close) return false;
    close.click();
    return true;
  });
  await page.waitForTimeout(300);
  const closed = await read();
  check(
    opened.taskPane && closedByButton && !closed.taskPane,
    `选中形状自动弹出、点 ✕ 收起（弹出 ${opened.taskPane} → 收起 ${!closed.taskPane}）`,
  );

  // ③ 页面居中：左右留白差 ≤ 2px
  const gapLeft = initial.page.left - initial.frame.left;
  const gapRight =
    initial.frame.left + initial.frame.width - (initial.page.left + initial.page.width);
  check(
    Math.abs(gapLeft - gapRight) <= 2,
    `画布里的页面居中（左留白 ${Math.round(gapLeft)}px / 右留白 ${Math.round(gapRight)}px）`,
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
  const expectedPageWidth = (after.frame.width - 16) * ((after.zoom ?? 0) / 100);
  check(
    frameGrew <= 2 && Math.abs(after.page.width - expectedPageWidth) <= 4,
    `缩放不把画布框撑宽（框 ${Math.round(before.frame.width)} → ${Math.round(after.frame.width)}px，页面 ${Math.round(after.page.width)}px ≈ 框宽×${after.zoom}%）`,
  );
}
