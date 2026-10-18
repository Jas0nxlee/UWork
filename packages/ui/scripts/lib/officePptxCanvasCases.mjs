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
  /** 取点在每次点击前重取画布矩形：界面会滚动（比如双击把焦点给了文本框），旧矩形会失效。 */
  const centerLive = async (box) => {
    const c = await readCanvas();
    return {
      x: c.layer.left + ((box.x + box.width / 2) / EMU_PER_PX) * c.scale,
      y: c.layer.top + ((box.y + box.height / 2) / EMU_PER_PX) * c.scale,
    };
  };
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

  // ④ 点空白处 → 取消选择。空白处取"页面右上角"：形状都在左半与中部，
  // 而画布比视口高时页面底部会落在视口外（鼠标事件发不出去，断言会假失败——踩过）
  const emptyX = layer.left + layer.width * 0.82;
  const emptyY = layer.top + layer.height * 0.12;
  const inViewport = await page.evaluate(
    ([x, y]) => x > 0 && y > 0 && x < innerWidth && y < innerHeight,
    [emptyX, emptyY],
  );
  check(inViewport, `空白点落在视口内（${Math.round(emptyX)},${Math.round(emptyY)}）`);
  await page.mouse.click(emptyX, emptyY);
  await page.waitForTimeout(200);
  const cleared = await readCanvas();
  const emptyDiag = await page.evaluate(
    ([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return {
        at: [Math.round(x), Math.round(y)],
        hit: hit
          ? `${hit.tagName}[${hit.getAttribute("data-pptx-canvas-layer") !== null ? "layer" : (hit.getAttribute("class") ?? "").slice(0, 30)}]`
          : "null",
        isLayer: hit?.getAttribute("data-pptx-canvas-layer") !== null,
      };
    },
    [emptyX, emptyY],
  );
  check(
    cleared?.selected === null && cleared?.handles === 0,
    `点空白处取消选择（选框与手柄都收起来）｜点 ${JSON.stringify(emptyDiag)}｜点了以后 selected=${cleared?.selected} handles=${cleared?.handles}`,
  );

  // ⑤ 双击形状 → **在页面上就地改字**（编辑层出现在形状的位置上，字号按形状的格式算）
  const titleAgain = center(resized);
  await page.mouse.dblclick(titleAgain.x, titleAgain.y);
  await page.waitForTimeout(400);
  const editing = await page.evaluate(() => {
    const node = document.querySelector("[data-pptx-text-editor]");
    const canvas = window.__pptxPane?.canvas?.() ?? null;
    return node
      ? {
          value: node.value,
          fontSize: getComputedStyle(node).fontSize,
          editingText: canvas?.editingText ?? false,
          handles: canvas?.handles ?? -1,
        }
      : null;
  });
  check(
    Boolean(editing) && editing.value.includes("标题一"),
    `双击形状就在页面上改字（编辑层里是原文 ${JSON.stringify(editing?.value ?? null)}）`,
  );
  check(
    editing?.editingText === true && editing.handles === 0,
    "就地改字时选框与手柄让位（不挡编辑）",
  );
  // 双击的**第二下**会把刚聚焦的编辑层 blur 掉：编辑层必须扛住这一下活下来
  // （真机实测：没有这条保护时"双击进编辑"会被自己立刻关掉，看起来就是双击没反应）
  await page.waitForTimeout(900);
  const survived = await page.evaluate(() => ({
    editor: Boolean(document.querySelector("[data-pptx-text-editor]")),
    focused: document.activeElement?.getAttribute("data-pptx-text-editor") !== null,
  }));
  check(survived.editor && survived.focused, "编辑层扛住了双击第二下的失焦（还在编辑、仍聚焦）");
  // 敲一个字要落到编辑层里（不是在画布上乱窜）
  await page.keyboard.press("End");
  await page.keyboard.type("X");
  const typed = await page.evaluate(
    () => document.querySelector("[data-pptx-text-editor]")?.value ?? "",
  );
  check(typed.includes("X"), `键入落到编辑层（现在 ${JSON.stringify(typed.slice(0, 16))}…）`);
  await page.keyboard.press("Escape");
  // 字号 = 形状的磅值 × 4/3 × scale（渲染器是 96dpi 像素）
  const expectedFont = Math.max(9, 20 * (4 / 3) * mounted.scale).toFixed(1);
  check(
    editing !== null &&
      Math.abs(Number.parseFloat(editing.fontSize) - Number.parseFloat(expectedFont)) < 1.5,
    `编辑层字号按形状格式算（${editing?.fontSize} ≈ ${expectedFont}px）`,
  );

  // ⑤b Esc = 放弃：文本不变、编辑层消失
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const afterCancel = await page.evaluate(() => ({
    editor: Boolean(document.querySelector("[data-pptx-text-editor]")),
    status: document.querySelector("[data-office-toolbar]")?.textContent?.slice(-40) ?? "",
  }));
  check(!afterCancel.editor, "Esc 退出就地改字、不改文本");

  // ⑤c 改字 → 点到别处提交：这一页 XML 里的文字变了
  const beforeText = await page.evaluate(() => {
    const part = window.__pptxPane.slideCount ? document.querySelector("[data-pptx-block]") : null;
    return part?.value ?? null;
  });
  const againPoint = center(resized);
  await page.mouse.dblclick(againPoint.x, againPoint.y);
  await page.waitForTimeout(400);
  const diagOpen = await page.evaluate(() => ({
    editor: Boolean(document.querySelector("[data-pptx-text-editor]")),
    focused: document.activeElement?.tagName ?? null,
    value: document.querySelector("[data-pptx-text-editor]")?.value?.slice(0, 14) ?? null,
    hits: (() => {
      const node = document.elementFromPoint(
        document.querySelector("[data-pptx-canvas-layer]")?.getBoundingClientRect().left + 5,
        document.querySelector("[data-pptx-canvas-layer]")?.getBoundingClientRect().top + 5,
      );
      return node ? `${node.tagName}[${(node.getAttribute("class") ?? "").slice(0, 24)}]` : null;
    })(),
  }));
  console.log("⑤c after dblclick:", JSON.stringify(diagOpen));
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("改过的标题");
  const diagTyped = await page.evaluate(
    () => document.querySelector("[data-pptx-text-editor]")?.value?.slice(0, 20) ?? null,
  );
  console.log("⑤c after typing:", JSON.stringify(diagTyped));
  const emptyPoint = await page.evaluate(() => {
    const canvas = window.__pptxPane.canvas();
    return {
      x: canvas.layer.left + canvas.layer.width * 0.8,
      y: canvas.layer.top + canvas.layer.height * 0.15,
    };
  });
  await page.mouse.click(emptyPoint.x, emptyPoint.y);
  await page.waitForTimeout(700);
  const committed = await page.evaluate(() => {
    const editor = Boolean(document.querySelector("[data-pptx-text-editor]"));
    const blocks = [...document.querySelectorAll("[data-pptx-block]")].map((node) => node.value);
    const status = document.querySelector("[data-office-toolbar]")?.textContent?.slice(-46) ?? "";
    return { editor, blocks, status };
  });
  check(
    !committed.editor && committed.blocks.some((text) => String(text).includes("改过的标题")),
    `点到别处＝提交，文字进了这一页（${JSON.stringify(committed.blocks).slice(0, 60)}｜${committed.status}）`,
  );
  void beforeText;

  // ⑥ 形状拖到页面外之后，四个角手柄仍然抓得住（真机上踩过：手柄被画框裁掉＝"看得见点不着"）
  // 先把画布框撑高：裸检查页没有 CSS，列高会塌成 160px，页面会小到"拖出去＝整块在页外"，
  // 那种情况下四个手柄会夹到同一个角，验不出"每个手柄都可点"这件事。
  await page.evaluate(() => {
    const frame = document.querySelector("[data-pptx-canvas-frame]");
    if (frame) frame.style.minHeight = "620px";
  });
  await page.waitForTimeout(400);
  // （先确认不在编辑态：编辑时手柄是藏起来的，那是设计）
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);
  await page.evaluate(() =>
    document.querySelector("[data-pptx-canvas-frame]")?.scrollIntoView({ block: "center" }),
  );
  await page.waitForTimeout(250);
  // 上一步双击把焦点给了文本框，可能顺带滚动了；重新点选一次再拖
  const beforeOff = await readBox("标题 1");
  await page.mouse.click((await centerLive(beforeOff)).x, (await centerLive(beforeOff)).y);
  await page.waitForTimeout(250);
  const offPoint = await centerLive(await readBox("标题 1"));
  const dragDiag = { before: await readBox("标题 1"), offPoint, canvas: await readCanvas() };
  await page.mouse.move(offPoint.x, offPoint.y);
  await page.mouse.down();
  await page.mouse.move(offPoint.x + 420, offPoint.y + 320, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const pushed = await readBox("标题 1");
  console.log(
    "dragDiag",
    JSON.stringify({ ...dragDiag, after: pushed, afterCanvas: await readCanvas() }),
  );
  const reachable = await page.evaluate(() => {
    const out = {};
    const frame = document.querySelector("[data-pptx-canvas-frame]")?.getBoundingClientRect();
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const node = document.querySelector(`[data-pptx-canvas-handle='${corner}']`);
      if (!node) {
        out[corner] = { ok: false, note: "手柄不存在" };
        continue;
      }
      const rect = node.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      out[corner] = {
        ok: hit === node,
        style: node.getAttribute("style"),
        boxStyle: node.parentElement?.getAttribute("style")?.slice(0, 120),
        at: [Math.round(cx), Math.round(cy)],
        hit: hit
          ? `${hit.tagName}[${hit.getAttribute("data-pptx-canvas-handle") ?? (hit.getAttribute("class") ?? "").slice(0, 24)}]`
          : "null",
        outOfViewport: cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight,
        vsFrame: [Math.round(rect.left - frame.left), Math.round(rect.top - frame.top)],
      };
    }
    return {
      viewport: [innerWidth, innerHeight],
      frame: frame && [
        Math.round(frame.left),
        Math.round(frame.top),
        Math.round(frame.width),
        Math.round(frame.height),
      ],
      handles: out,
    };
  });
  check(
    Object.values(reachable.handles).every((h) => h.ok),
    `形状拖到页面外后四个手柄都还抓得住（视口 ${reachable.viewport}，框 ${reachable.frame}，手柄 ${JSON.stringify(reachable.handles)}）`,
  );
  const seHandle = await page.evaluate(() => {
    const rect = document.querySelector("[data-pptx-canvas-handle='se']").getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(seHandle.x, seHandle.y);
  await page.mouse.down();
  await page.mouse.move(seHandle.x + 30, seHandle.y + 24, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterOffPageResize = await readBox("标题 1");
  check(
    afterOffPageResize.width > pushed.width && afterOffPageResize.height > pushed.height,
    `页面外的形状也能缩放（${pushed.width}×${pushed.height} → ${afterOffPageResize.width}×${afterOffPageResize.height}）`,
  );
}
