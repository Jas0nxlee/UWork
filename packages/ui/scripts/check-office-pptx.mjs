/**
 * PPTX 文字编辑的回归：解析 → 改字 → 写回，验证
 *   ① 文本块与段落读得对（含 run 被拆开、段内换行 `a:br`、表格单元格里的 txBody）；
 *   ② 改一行只动那一行所在的那张幻灯片；**其余部件逐字节保留**（图片/备注/母版/关系）；
 *   ③ 段落数变化时新增行沿用该块首段样式（不是变成默认字体）；
 *   ④ 导出后能用**我们自己的渲染器**（@aiden0z/pptx-renderer）打开——证明确实是一份合法 pptx；
 *   ⑤ 产物校验能拦住"部件被改动""文字量塌掉""幻灯片数变了"这些坏产物；
 *   ⑥ 没改就不写盘。
 *
 * 用法：node packages/ui/scripts/check-office-pptx.mjs
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PPTX_PAGE, bundlePptxEntry } from "./lib/officePptxPage.mjs";
import { startOfficeHarness } from "./lib/officeEditorHarness.mjs";
import { runPptxCanvasCases } from "./lib/officePptxCanvasCases.mjs";
import { runPptxPanelCases } from "./lib/officePptxPanelCases.mjs";
import { runPptxPicturePipelineCases } from "./lib/officePptxPicturePipelineCases.mjs";
import { runPptxRibbonCases } from "./lib/officePptxRibbonCases.mjs";
import { runPptxStyledCanvasCases } from "./lib/officePptxStyledCanvasCases.mjs";
import { runPptxEditCases } from "./lib/officePptxEditCases.mjs";
import { runPptxUiCases } from "./lib/officePptxUiCases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");

async function main() {
  const started = Date.now();
  const stage = (name) => console.log(`… ${name}（${Math.round((Date.now() - started) / 1000)}s）`);
  stage("打产物");
  const harness = await startOfficeHarness({
    prefix: "office-pptx-",
    pages: { "index.html": PPTX_PAGE },
    // 真样本（给人手点的那份）也要过一遍：用户第一次打开的很可能就是它
    copies: {
      [join(repoRoot, "packages/ui/test/fixtures/office-sample.pptx")]: "office-sample.pptx",
      // 插图片用例要的样本图（240×120，与 Word 检查同一张）
      [join(repoRoot, "packages/ui/test/fixtures/office-editor-image.png")]:
        "office-editor-image.png",
    },
    prepareDir: (dir) =>
      bundlePptxEntry(dir, {
        repoRoot,
        editorDir,
        modules: [
          "pptText.ts",
          "pptShapes.ts",
          "pptSlides.ts",
          "pptPicture.ts",
          "pptxValidate.ts",
          "usePptxDocument.ts",
        ],
      }),
    viewport: { width: 1200, height: 800 },
  });
  stage("页面就绪");
  const page = harness.page;

  const failures = [];
  const check = (ok, message) => {
    if (ok) console.log(`ok   ${message}`);
    else {
      console.log(`FAIL ${message}`);
      failures.push(message);
    }
  };
  await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60000 });

  // ① 解析：两块文字（普通文本框 + 表格单元格），含被拆开的 run 与段内换行
  const parsed = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    window.__pptxSource = bytes;
    const deck = await window.__pptx.readDeck(bytes);
    return {
      slides: deck.slides.map((slide) => ({
        partName: slide.partName,
        blocks: slide.blocks.map((block) => ({ label: block.label, lines: block.lines })),
      })),
      parts: Object.keys(await window.__pptx.parts(bytes)).sort(),
    };
  });
  check(parsed.slides.length === 2, `两张幻灯片都读出来（${parsed.slides.length}）`);
  const first = parsed.slides[0];
  check(
    first.blocks.length === 2,
    `第 1 页读到一个文本框 + 一个表格（${first.blocks.map((block) => block.label).join("、")}）`,
  );
  check(
    first.blocks[0].lines.join("|") === "标题一|副标题",
    `拆开的 run 拼回一整行、段内换行拆成两行（${JSON.stringify(first.blocks[0].lines)}）`,
  );
  check(
    parsed.parts.includes("ppt/media/image1.png") &&
      parsed.parts.includes("ppt/notesSlides/notesSlide1.xml"),
    `素材与备注都在（${parsed.parts.filter((name) => /media|notesSlide/.test(name)).join("、")}）`,
  );

  // ② 改一行 → 写回：只动那一页，其余部件逐字节一致
  const written = await page.evaluate(async () => {
    const read = await window.__pptx.readDeck(window.__pptxSource);
    const part = read.slides[0].partName;
    const patched = window.__pptx.patch(read.sourceXml.get(part), 0, ["新的标题", "新的副标题"]);
    const current = new Map(read.sourceXml);
    current.set(part, patched);
    const result = await window.__pptx.write({
      source: window.__pptxSource,
      baseline: read.sourceXml,
      current,
    });
    const validation = await window.__pptx.validate(result.bytes, window.__pptxSource, {
      editedSlides: result.changedSlides,
    });
    const before = await window.__pptx.parts(window.__pptxSource);
    const after = await window.__pptx.parts(result.bytes);
    const changedParts = Object.keys(before).filter((name) => before[name] !== after[name]);
    const reread = await window.__pptx.readDeck(result.bytes);
    window.__pptxPatched = result.bytes;
    return {
      changedSlides: result.changedSlides,
      changedParts,
      validation: { ok: validation.ok, issues: validation.issues.map((issue) => issue.message) },
      lines: reread.slides[0].blocks[0].lines,
      tableLines: reread.slides[0].blocks[1]?.lines,
      slideCount: reread.slides.length,
      secondSlideLines: reread.slides[1].blocks[0]?.lines,
    };
  });
  check(
    written.changedSlides.length === 1 && written.changedParts.length === 1,
    `只改了一张幻灯片（${written.changedSlides.join("、")}｜变化的部件：${written.changedParts.join("、")}）`,
  );
  check(
    written.lines.join("|") === "新的标题|新的副标题",
    `改后的文字读回来是对的（${JSON.stringify(written.lines)}）`,
  );
  check(
    written.tableLines?.length === 1 && written.secondSlideLines?.length === 1,
    `同页另一块与另一页都没被动（表格 ${JSON.stringify(written.tableLines)}｜第 2 页 ${JSON.stringify(written.secondSlideLines)}）`,
  );
  check(
    written.validation.ok,
    `产物通过校验（${written.validation.issues.join("；") || "无问题"}）`,
  );

  // ③ 段落数变化：新增行要沿用首段样式（这里是 20pt 粗体），而不是无样式的默认 run
  const grown = await page.evaluate(async () => {
    const read = await window.__pptx.readDeck(window.__pptxSource);
    const part = read.slides[0].partName;
    const patched = window.__pptx.patch(read.sourceXml.get(part), 0, ["A", "B", "C"]);
    return {
      paragraphs: window.__pptx.paragraphs(patched, 0),
      runs: window.__pptx.runTexts(patched, 0),
    };
  });
  check(
    grown.paragraphs.length === 3 && grown.runs.join("|") === "A|B|C",
    `加行后段落数与文字都对（${grown.runs.join("|")}）`,
  );
  check(
    grown.paragraphs.every(
      (paragraph) => paragraph.includes('sz="2000"') && paragraph.includes('b="1"'),
    ),
    "新增的行沿用了首段样式（20pt 粗体）",
  );

  // ④ 产物能不能被真正的渲染器打开（我们自己在用的 @aiden0z/pptx-renderer 就是 pptxjs）
  const rendered = await page.evaluate(async () => {
    try {
      const result = await window.__pptx.render(window.__pptxPatched);
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 200) };
    }
  });
  check(
    rendered.ok && rendered.slides >= 1,
    `产物能被 pptx 渲染器打开（${rendered.slides ?? "?"} 页${rendered.ok ? "" : `｜${rendered.error}`}）`,
  );

  // ⑤ 校验要能拦住坏产物：部件被改 / 文字量塌掉 / 幻灯片丢了
  const validationCases = await page.evaluate(async () => {
    const read = await window.__pptx.readDeck(window.__pptxSource);
    const zipSource = await window.__pptx.rawZip(window.__pptxSource);
    // 坏产物 A：偷偷改了图片
    const zipA = await window.__pptx.rawZip(window.__pptxSource);
    zipA.file("ppt/media/image1.png", "被改了");
    const bytesA = await zipA.generateAsync({ type: "arraybuffer" });
    // 坏产物 B：把第 1 页的文字清空
    const zipB = await window.__pptx.rawZip(window.__pptxSource);
    zipB.file(
      "ppt/slides/slide1.xml",
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>',
    );
    const bytesB = await zipB.generateAsync({ type: "arraybuffer" });
    // 坏产物 C：删掉一张幻灯片
    const zipC = await window.__pptx.rawZip(window.__pptxSource);
    zipC.remove("ppt/slides/slide2.xml");
    const bytesC = await zipC.generateAsync({ type: "arraybuffer" });
    return {
      modified: await window.__pptx.validate(bytesA, window.__pptxSource, { editedSlides: [] }),
      emptied: await window.__pptx.validate(bytesB, window.__pptxSource, {
        editedSlides: ["ppt/slides/slide1.xml"],
      }),
      missing: await window.__pptx.validate(bytesC, window.__pptxSource, { editedSlides: [] }),
      clean: await window.__pptx.validate(
        (await read.sourceXml) ? window.__pptxSource : window.__pptxSource,
        window.__pptxSource,
        {},
      ),
      zipSourceOk: Boolean(zipSource),
    };
  });
  check(
    !validationCases.modified.ok &&
      validationCases.modified.issues.some((issue) => issue.kind === "part-modified"),
    `校验认出"没编辑的部件被改了"（${validationCases.modified.issues.map((issue) => issue.message).join("；")}）`,
  );
  check(
    !validationCases.emptied.ok &&
      validationCases.emptied.issues.some((issue) => issue.kind === "text-lost"),
    `校验认出"文字被清空"（${validationCases.emptied.issues.map((issue) => issue.message).join("；")}）`,
  );
  check(
    !validationCases.missing.ok &&
      validationCases.missing.issues.some((issue) => issue.kind === "part-modified"),
    `校验认出"幻灯片丢了"（${validationCases.missing.issues.map((issue) => issue.message).join("；")}）`,
  );
  check(validationCases.clean.ok, "原样文件校验通过（不误报）");

  // ⑥ 界面：文本块渲染成 textarea，改一下能标脏
  const ui = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    await window.__pptx.mountPane(bytes);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const slides = [...document.querySelectorAll("[data-pptx-slide]")];
    // 文本块在右侧「设置形状格式」窗格里，而窗格**默认收起**（免得挤窄画布）——先点开它
    const openFormat = document.querySelector("[data-pptx-open-format]");
    openFormat?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const areas = [...document.querySelectorAll("[data-pptx-block]")];
    return {
      areas: areas.length,
      slideButtons: slides.length,
      opened: Boolean(document.querySelector("[data-pptx-task-pane]")),
      first: areas[0]?.value ?? null,
      status: document.querySelector("[data-office-toolbar]")?.textContent?.slice(0, 80) ?? "",
    };
  });
  check(
    ui.areas === 2 && ui.slideButtons === 2 && ui.opened,
    `界面渲染出 2 页缩略图 / 2 个文本框（窗格按需打开 ${ui.opened}）`,
  );
  check(ui.first === "标题一\n副标题", `文本框里是原文（${JSON.stringify(ui.first)}）`);
  check(
    ui.status.includes("已载入") && ui.status.includes("张幻灯片"),
    `状态栏交代清楚（${ui.status}）`,
  );

  await runPptxEditCases({ page, check });

  // ⑦ 真样本文件：4 页、能改字、产物能渲染
  const sample = await page.evaluate(async () => {
    const bytes = await (await fetch("/office-sample.pptx")).arrayBuffer();
    const deck = await window.__pptx.readDeck(bytes);
    const part = deck.slides[0].partName;
    const patched = window.__pptx.patch(deck.sourceXml.get(part), 0, [
      "季度经营回顾（改过）",
      "2026 Q3",
    ]);
    const current = new Map(deck.sourceXml);
    current.set(part, patched);
    const written = await window.__pptx.write({ source: bytes, baseline: deck.sourceXml, current });
    const validation = await window.__pptx.validate(written.bytes, bytes, {
      editedSlides: written.changedSlides,
    });
    const rendered = await window.__pptx.render(written.bytes);
    const reread = await window.__pptx.readDeck(written.bytes);
    return {
      slides: deck.slides.length,
      tableCells: deck.slides[2].blocks.length,
      lines: reread.slides[0].blocks[0].lines,
      validation: { ok: validation.ok, issues: validation.issues.map((issue) => issue.message) },
      rendered,
    };
  });
  check(sample.slides === 4, `真样本读得出 4 页（${sample.slides}）`);
  check(sample.tableCells === 12, `真样本的表格是按单元格解析的（${sample.tableCells} 个文本块）`);
  check(
    sample.lines.join("|") === "季度经营回顾（改过）|2026 Q3",
    `真样本改字后读回来是对的（${JSON.stringify(sample.lines)}）`,
  );
  check(
    sample.validation.ok,
    `真样本产物通过校验（${sample.validation.issues.join("；") || "无问题"}）`,
  );
  check(sample.rendered.slides === 4, `真样本产物能被渲染器打开（${sample.rendered.slides} 页）`);

  // ⑧ 插图片：媒体部件 + 这一页 .rels + p:pic 都进包，尺寸等比放进页面，渲染器仍能打开
  const picture = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    const deck = await window.__pptx.readDeck(bytes);
    const part = deck.slides[0].partName;
    const dataUri = await window.__pptx.sampleImageDataUri();
    const result = await window.__pptx.insertPicture({
      source: bytes,
      partName: part,
      dataUri,
      pageWidth: 9144000,
      pageHeight: 6858000,
    });
    const zip = await window.__pptx.rawZip(result.bytes);
    const relsName = `ppt/slides/_rels/${part.split("/").pop()}.rels`;
    const rels = (await zip.file(relsName)?.async("string")) ?? "";
    const slideXml = (await zip.file(part)?.async("string")) ?? "";
    const pictureXml = slideXml.slice(slideXml.indexOf("<p:pic"));
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(pictureXml);
    const shapes = window.__pptx.readShapes(slideXml);
    const rendered = await window.__pptx.render(result.bytes);
    return {
      media: result.mediaName,
      mediaBytes: (await zip.file(result.mediaName)?.async("uint8array"))?.byteLength ?? 0,
      rel: result.relationshipId,
      relsHasImage: rels.includes("image") && rels.includes(result.relationshipId),
      picCount: (slideXml.match(/<p:pic>/g) ?? []).length,
      ext: ext ? { cx: Number(ext[1]), cy: Number(ext[2]) } : null,
      shapeKinds: shapes.map((shape) => `${shape.name}:${shape.kind}`),
      rendered,
      sourceSlides: deck.slides.length,
    };
  });
  check(
    picture.media.startsWith("ppt/media/image") && picture.mediaBytes > 100,
    `图片进包（${picture.media}，${picture.mediaBytes} 字节）`,
  );
  check(
    picture.relsHasImage && picture.picCount === 1,
    `这一页的关系与 p:pic 都对（${picture.rel}，p:pic ×${picture.picCount}）`,
  );
  // 规则：等比放进页面，最多占页面宽的 60%（240×120 → 宽 60%、高按比例＝宽的一半）
  const expectedCx = Math.round(9144000 * 0.6);
  const expectedCy = Math.round(expectedCx / 2);
  check(
    picture.ext !== null && picture.ext.cx === expectedCx && picture.ext.cy === expectedCy,
    `按 240×120 等比放进页面（${picture.ext?.cx}×${picture.ext?.cy} EMU，期望 ${expectedCx}×${expectedCy}）`,
  );
  check(
    picture.shapeKinds.some((item) => item.endsWith(":pic")),
    `形状层认得这张图（${picture.shapeKinds.join("、")}）`,
  );
  check(picture.rendered.slides === picture.sourceSlides, "插了图片之后渲染器仍能打开这份 deck");

  await runPptxUiCases({ page, check });
  await runPptxCanvasCases({ page, check });
  await runPptxStyledCanvasCases({ repoRoot, editorDir, check });
  await runPptxRibbonCases({ page, check });
  await runPptxPanelCases({ page, check });
  await runPptxPicturePipelineCases({
    page,
    check,
    imagePath: join(repoRoot, "packages/ui/test/fixtures/office-editor-image.png"),
  });

  await harness.close();
  if (failures.length > 0) {
    console.log(`\n${failures.length} 条未通过`);
    process.exitCode = 1;
  } else {
    console.log("\nPPTX 文字编辑检查全部通过");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
