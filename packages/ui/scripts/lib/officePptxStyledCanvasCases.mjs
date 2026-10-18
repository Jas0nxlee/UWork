/**
 * PPT 画布在**有 Tailwind 的真实布局**下的断言（界面级的第二遍）。
 *
 * 为什么单独一遍：主检查页是裸 HTML（没有 Tailwind），我在那儿踩过一次坑——
 * 画布用 class 写 `relative`/`overflow-hidden`/`origin-top-left`，裸页面里全部失效，
 * 缩放层绕中心放大、盖住整个编辑位，左侧列表点不动。所以这里**带上真编译的 Tailwind CSS**，
 * 把编辑位放进一个"侧栏尺寸"的容器里再验一遍：
 *   ① 画布不越出自己的列（不盖住左侧幻灯片列表）；
 *   ② 缩放后的渲染面与交互层都夹在画布框内（`overflow-hidden` 真的生效）；
 *   ③ 有 Tailwind 时点击依然能选中形状（换算与命中测试不依赖样式）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PPTX_PAGE, bundlePptxEntry } from "./officePptxPage.mjs";
import { startOfficeHarness } from "./officeEditorHarness.mjs";
import { emitTailwindCss } from "./tailwindHarnessCss.mjs";

/** 侧栏尺寸的宿主 + 真 CSS（`#host` 模拟编辑位在侧栏里的可用区域）。 */
const PAGE = PPTX_PAGE.replace(
  '<div id="host"></div>',
  `<link rel="stylesheet" href="/harness.css">
<style>
  #host { width: 820px; height: 620px; display: flex; }
  #host > div { flex: 1; min-width: 0; min-height: 0; }
</style>
<div id="host"></div>`,
);

export async function runPptxStyledCanvasCases({ repoRoot, editorDir, check }) {
  const harness = await startOfficeHarness({
    prefix: "office-pptx-styled-",
    pages: { "index.html": PAGE },
    prepareDir: async (dir) => {
      await bundlePptxEntry(dir, {
        repoRoot,
        editorDir,
        modules: [
          "pptText.ts",
          "pptShapes.ts",
          "pptSlides.ts",
          "pptxValidate.ts",
          "usePptxDocument.ts",
        ],
      });
      await emitTailwindCss({ dir, bundle: readFileSync(join(dir, "pptx.js"), "utf8"), repoRoot });
    },
    viewport: { width: 1200, height: 800 },
  });
  const { page } = harness;
  try {
    await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60000 });
    const styled = await page.evaluate(async () => {
      const { bytes } = await window.__pptx.fixture();
      await window.__pptx.mountPane(bytes.slice(0));
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (window.__pptxPane?.canvas?.()?.ready) break;
      }
      const canvas = window.__pptxPane?.canvas?.() ?? null;
      const list = document.querySelector("[data-pptx-slide]");
      const listRect = list?.getBoundingClientRect() ?? null;
      const host = document.getElementById("host");
      const hostRect = host.getBoundingClientRect();
      return {
        canvas,
        hostRect: { left: hostRect.left, right: hostRect.right, width: hostRect.width },
        listRect: listRect ? { left: listRect.left, right: listRect.right } : null,
        /** 左侧列表按钮的中心点由谁接住（没被盖住就该是按钮自己）。 */
        topAtList:
          document
            .elementFromPoint(
              (listRect?.left ?? 0) + 10,
              (listRect?.top ?? 0) + (listRect?.height ?? 0) / 2,
            )
            ?.closest("[data-pptx-slide]") !== null,
        /** 字号是不是真的生效了（证明 Tailwind CSS 确实编译进来了）。 */
        listFontSize: list ? getComputedStyle(list).fontSize : null,
      };
    });
    const canvas = styled.canvas;
    const frame = canvas?.frame;
    const layer = canvas?.layer;
    check(
      styled.listFontSize === "12px",
      `检查页真的带上了 Tailwind（左侧列表字号 ${styled.listFontSize}，text-xs）`,
    );
    check(
      Boolean(frame) &&
        frame.left >= (styled.listRect?.right ?? 0) - 1 &&
        frame.width < styled.hostRect.width,
      `画布不越出自己的列（画布 ${Math.round(frame?.left ?? -1)}~${Math.round((frame?.left ?? 0) + (frame?.width ?? 0))}，列表右缘 ${Math.round(styled.listRect?.right ?? -1)}）`,
    );
    check(styled.topAtList === true, "缩放层没有盖住左侧幻灯片列表（点击落回列表本身）");
    check(
      Boolean(layer) &&
        layer.left >= frame.left - 1 &&
        layer.left + layer.width <= frame.left + frame.width + 1 &&
        layer.top + layer.height <= frame.top + frame.height + 1,
      "缩放后的渲染面与交互层都夹在画布框内（overflow-hidden 生效）",
    );

    // 有 Tailwind 时仍然点得中形状（命中测试与换算不该依赖样式）
    const box = await page.evaluate(() => window.__pptxPane?.shapeBox?.("标题 1") ?? null);
    if (box) {
      const target = {
        x: layer.left + ((box.x + box.width / 2) / 9525) * canvas.scale,
        y: layer.top + ((box.y + box.height / 2) / 9525) * canvas.scale,
      };
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(250);
      const selected = await page.evaluate(() => window.__pptxPane?.canvas?.()?.selected ?? null);
      check(selected === "标题 1", `有 Tailwind 时画布上点形状仍能选中（选中「${selected}」）`);
    } else {
      check(false, "取不到「标题 1」的几何（形状层在带样式的页面里没读出来）");
    }
  } finally {
    await harness.close();
  }
}
