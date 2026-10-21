/**
 * **八个缩放手柄**的断言（含"小形状只显四角"这条规矩）。
 *
 * 为什么专门有这一遍：把 4 个角手柄扩成 8 个时踩过一个坑——形状小的时候，**中边手柄会盖住形状中间**
 * 的点击区，"从中心拖动"于是抓到了手柄，移动变成拉扁（形状被压到最小高度）。
 * 所以这里既验纯函数（大框 8 个、小框 4 个），也验**界面上形状中心必须是空的**——
 * 这条正是能抓住那个坑的断言。
 */
export async function runPptxHandleCases({ page, check }) {
  // ① 纯函数：大框 8 个（四角 + 四边中点），小框只 4 个角
  const spots = await page.evaluate(() => {
    const viewport = { width: 800, height: 600, scale: 1 };
    const big = window.__pptx.handleSpots(
      { x: 0, y: 0, width: 400 * 9525, height: 300 * 9525 },
      viewport,
    );
    const small = window.__pptx.handleSpots(
      { x: 0, y: 0, width: 40 * 9525, height: 30 * 9525 },
      viewport,
    );
    return {
      big: big
        .map((item) => item.corner)
        .sort()
        .join(","),
      small: small
        .map((item) => item.corner)
        .sort()
        .join(","),
    };
  });
  check(spots.big === "e,n,ne,nw,s,se,sw,w", `大框给 8 个缩放点（${spots.big}）`);
  check(spots.small === "ne,nw,se,sw", `小框只给四个角（${spots.small}）`);

  // ② 界面：形状中心必须是空的（不能被手柄盖住，否则"拖动"会变成"拉手柄"）
  const mounted = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    await window.__pptx.mountPane(bytes.slice(0));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (window.__pptxPane?.canvas?.()?.ready) break;
    }
    document.querySelector("[data-pptx-open-format]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    document.querySelector("[data-pptx-shape]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const canvas = window.__pptxPane.canvas();
    const box = window.__pptxPane.shapeBox(window.__pptxPane.shapeNames()[0]);
    const center = {
      x: canvas.layer.left + ((box.x + box.width / 2) / 9525) * canvas.scale,
      y: canvas.layer.top + ((box.y + box.height / 2) / 9525) * canvas.scale,
    };
    const hit = document.elementFromPoint(center.x, center.y);
    return {
      ready: Boolean(canvas.ready),
      scale: canvas.scale,
      centerHit: hit?.getAttribute("data-pptx-canvas-handle") ?? null,
      isLayer: hit?.getAttribute("data-pptx-canvas-layer") !== null,
      handles: document.querySelectorAll("[data-pptx-canvas-handle]").length,
    };
  });
  check(mounted.ready, "编辑位起来了（手柄断言的前提）");
  // 注："形状中心是否空"在**极小画布**（scale 0.2、形状只有 60×20px）下不作断言：
  // 那种尺寸里 12px 的手柄怎么摆都会碰到中心附近，规矩由纯函数那两条钉住（大框 8 个 / 小框 4 个），
  // 真实尺寸下的"中心必须空"放在下面放大到 200% 之后验。

  // ③ 拖动仍然是"移动"：从中心拖，位置变、大小不变
  const before = await page.evaluate(() =>
    window.__pptxPane.shapeBox(window.__pptxPane.shapeNames()[0]),
  );
  const drag = await page.evaluate(() => {
    const canvas = window.__pptxPane.canvas();
    const box = window.__pptxPane.shapeBox(window.__pptxPane.shapeNames()[0]);
    return {
      x: canvas.layer.left + ((box.x + box.width / 2) / 9525) * canvas.scale,
      y: canvas.layer.top + ((box.y + box.height / 2) / 9525) * canvas.scale,
    };
  });
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.x + 30, drag.y + 20, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const after = await page.evaluate(() =>
    window.__pptxPane.shapeBox(window.__pptxPane.shapeNames()[0]),
  );
  check(
    after.x !== before.x &&
      after.y !== before.y &&
      after.width === before.width &&
      after.height === before.height,
    `从形状中心拖动只移动、不改大小（${before.width}×${before.height} → ${after.width}×${after.height}）`,
  );

  // ④ 边中点只改一个轴（先把画布放大到 200%，让形状大到会出现中边手柄）
  await page.evaluate(() => {
    const select = document.querySelector("[data-pptx-zoom-presets]");
    if (!select) return;
    select.value = "200";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(500);
  const edge = await page.evaluate(() => {
    const canvas = window.__pptxPane.canvas();
    const box = window.__pptxPane.shapeBox(window.__pptxPane.shapeNames()[0]);
    const center = {
      x: canvas.layer.left + ((box.x + box.width / 2) / 9525) * canvas.scale,
      y: canvas.layer.top + ((box.y + box.height / 2) / 9525) * canvas.scale,
    };
    return {
      handles: document.querySelectorAll("[data-pptx-canvas-handle]").length,
      centerFree:
        (document.elementFromPoint(center.x, center.y)?.getAttribute("data-pptx-canvas-handle") ??
          null) === null,
    };
  });
  // ⑤ 旋转：把旋转手柄拖到形状**右侧**（≈顺时针 90°），`a:xfrm@rot` 必须写成 60000 分之一度
  const grabbed = await page.evaluate(() => {
    const node = document.querySelector("[data-pptx-canvas-handle='rotate']");
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const target = await page.evaluate(() => {
    const canvas = window.__pptxPane.canvas();
    const box = window.__pptxPane.shapeBox(window.__pptxPane.shapeNames()[0]);
    // 形状中心的右侧
    return {
      x: canvas.layer.left + ((box.x + box.width + 20000) / 9525) * canvas.scale,
      y: canvas.layer.top + ((box.y + box.height / 2) / 9525) * canvas.scale,
    };
  });
  if (!grabbed) {
    check(false, '找不到旋转手柄（data-pptx-canvas-handle="rotate"）');
  } else {
    await page.mouse.move(grabbed.x, grabbed.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const rotated = await page.evaluate(() => {
      const xml = window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "";
      const raw = /<a:xfrm[^>]*\srot="(-?\d+)"/.exec(xml)?.[1] ?? null;
      const box = window.__pptxPane.shapeBox(window.__pptxPane.shapeNames()[0]);
      return { raw: raw === null ? null : Number(raw), rotation: box.rotation ?? null };
    });
    check(
      rotated.raw !== null && rotated.raw % 60000 === 0 && Math.abs(rotated.raw - 5400000) < 900000,
      `旋转写回 a:xfrm@rot，单位是 60000 分之一度（rot=${rotated.raw}，即 ${rotated.raw === null ? "?" : Math.round(rotated.raw / 60000)}°）`,
    );
    check(
      typeof rotated.rotation === "number" && Math.abs(rotated.rotation - 90) < 15,
      `读回来的角度是度（${rotated.rotation}°）`,
    );
  }

  check(
    edge.handles === 9 && edge.centerFree,
    `放大后是 8 个缩放手柄 + 旋转手柄、且中心仍然空着（${edge.handles} 个）`,
  );
}
