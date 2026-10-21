/**
 * **画布上的图片增删**（编辑位整条流水线：功能区 → deck 补丁 → 预览重算 → 画布重画）。
 *
 * 为什么单独一遍：数据层的断言（`officePptxEditCases` 的 ⑨）是直接调 `insertPicture` + `write` + `render`
 * 验的，**绕过了编辑位的预览流水线**——真机上"删掉图片后画布上那张图还在"正是漏在这里：
 * 形状列表已经没了（模型对了），画布却是旧画面。所以这一遍必须走界面 + 真实画布。
 */
export async function runPptxPicturePipelineCases({ page, check, imagePath }) {
  const mounted = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    await window.__pptx.mountPane(bytes.slice(0));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (window.__pptxPane?.canvas?.()?.ready) break;
    }
    // 打开右栏（形状列表在里面）
    document.querySelector("[data-pptx-open-format]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { ready: Boolean(window.__pptxPane?.canvas?.()?.ready) };
  });
  check(mounted.ready, "编辑位起来了（插图片用例的前提）");

  const canvasImages = () =>
    page.evaluate(() => {
      const host = document.querySelector("[data-pptx-canvas-host]");
      return {
        images: host?.querySelectorAll("img").length ?? -1,
        shapes: [...document.querySelectorAll("[data-pptx-shape]")].map((node) =>
          node.getAttribute("data-pptx-shape"),
        ),
      };
    });

  const before = await canvasImages();
  // ① 走功能区插一张图：打开取值对话框 → **真选一张本机图片** → 确定（与真机同一条路）
  const dialogOpened = await page.evaluate(async () => {
    // 「图片」在**插入**标签下：先切标签（默认停在"开始"）
    const tab = [...document.querySelectorAll("[data-office-ribbon-tab]")].find(
      (node) => (node.textContent ?? "").trim() === "插入",
    );
    tab?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const click = () =>
      [...document.querySelectorAll("button")].find((node) =>
        (node.getAttribute("title") ?? "").includes("插入本机图片"),
      );
    let node = click();
    if (!node) {
      document.querySelector("[data-office-ribbon-more]")?.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      node = click();
    }
    node?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return Boolean(document.querySelector("[data-office-ribbon-prompt-file]"));
  });
  await page.locator("[data-office-ribbon-prompt-file]").setInputFiles(imagePath);
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector("[data-office-ribbon-prompt-submit]")?.click());
  await page.waitForTimeout(2500);
  const afterInsert = await canvasImages();
  check(
    dialogOpened &&
      afterInsert.shapes.some((name) => name.startsWith("图片")) &&
      afterInsert.images > before.images,
    `插图片：形状列表与**画布**都出现了（形状 ${afterInsert.shapes.join("、")}｜画布图片 ${before.images} → ${afterInsert.images}）`,
  );

  // ② 选中它并删除 → 画布必须立刻少一张图（真机 bug：画布留着旧画面）
  const deleted = await page.evaluate(async () => {
    const name = window.__pptxPane.shapeNames().find((item) => item.startsWith("图片"));
    if (!name) return { clicked: false };
    document.querySelector(`[data-pptx-shape="${name}"]`)?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const node = [...document.querySelectorAll("button")].find(
      (item) => (item.textContent ?? "").trim() === "删除形状",
    );
    node?.click();
    return { clicked: true, name };
  });
  await page.waitForTimeout(2500);
  const afterDelete = await canvasImages();
  // 决定性事实：当前喂给渲染器的字节里，这一页到底还有没有 p:pic
  const bytesTruth = await page.evaluate(async () => {
    const bytes = window.__pptxPane?.previewBytes?.() ?? null;
    if (!bytes) return { hasBytes: false };
    const zip = await window.JSZip.loadAsync(bytes);
    const part = "ppt/slides/slide1.xml";
    const xml = (await zip.file(part)?.async("string")) ?? "";
    const names = Object.keys(zip.files).filter((name) => /^ppt\/media\//.test(name));
    return {
      hasBytes: true,
      picInSlide: /<p:pic[ >]/.test(xml),
      media: names,
      xmlLength: xml.length,
    };
  });
  const hostDump = await page.evaluate(() => {
    const host = document.querySelector("[data-pptx-canvas-host]");
    const img = host?.querySelector("img");
    return {
      html: (host?.innerHTML ?? "").slice(0, 260),
      imgSrc: (img?.getAttribute("src") ?? "").slice(0, 40),
      imgParent: img?.parentElement?.tagName ?? null,
      imgRect: img
        ? [
            Math.round(img.getBoundingClientRect().width),
            Math.round(img.getBoundingClientRect().height),
          ]
        : null,
      hosts: document.querySelectorAll("[data-pptx-canvas-host]").length,
      thumbs: [...document.querySelectorAll("[data-pptx-thumb-host]")].map(
        (n) => n.querySelectorAll("img").length,
      ),
      dataAttrs: host ? [...host.attributes].map((a) => `${a.name}=${a.value}`).join(" ") : "",
    };
  });
  const diag = await page.evaluate(() => ({
    builds: window.__pptxPane?.previewBuilds?.() ?? null,
    error: window.__pptxPane?.previewError?.() ?? null,
    status: document.querySelector("[data-office-toolbar]")?.textContent?.slice(-60) ?? "",
  }));
  check(
    deleted.clicked &&
      !afterDelete.shapes.some((name) => name.startsWith("图片")) &&
      afterDelete.images === before.images,
    `删图片：形状列表与**画布**都收回去了（剩下 ${afterDelete.shapes.join("、")}｜画布图片 ${afterInsert.images} → ${afterDelete.images}）｜预览重算 ${diag.builds} 次，错误 ${diag.error ?? "无"}｜${diag.status}｜字节里还有图吗=${JSON.stringify(bytesTruth)}｜host=${JSON.stringify(hostDump)}`,
  );
}
