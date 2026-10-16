/**
 * 编辑区**行为回归**：把真机的五条反馈变成断言（在无头 Chromium 里跑我们的真实调度代码）。
 *
 * 为什么与 check-office-editor-commands.mjs 分开：那个脚本按"引擎命令"逐条跑，只能证明引擎不抛错；
 * 真机反馈的问题恰恰出在**我们的参数与调度**上（纸张传了 "A4"、控件只给 type、连页用 "continuous" 比对、
 * 字数统计映射到引擎的清理命令、替换没实现）。所以这里用 esbuild 把 `officeEditorCommands.ts` 打成
 * 浏览器模块，直接调用我们自己的 `runEngineCommand`：
 *   ① 纸张大小换成像素后页面还在（不再整页空白）；
 *   ② 六种控件插出来**各不相同**（复选框/日期控件有选项、有日期格式，不再是空壳）；
 *   ③ 分页/连页能来回切；
 *   ④ 缩放能设到 150% 且引擎真的改了 scale；
 *   ⑤ 字数统计给出数字；查找能定位、替换真的改到文档文本。
 *
 * 用法：node packages/ui/scripts/check-office-editor-behavior.mjs
 * 依赖：仓库已装的 esbuild + playwright-core + 无头 Chromium（OFFICE_CHECK_CHROMIUM）。
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BEHAVIOR_PAGE, bundleDispatcher } from "./lib/officeBehaviorPage.mjs";
import { buildTrickyDocx } from "./lib/officeCheckFixtures.mjs";
import { engineAssetPaths, startOfficeHarness } from "./lib/officeEditorHarness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");

async function main() {
  const assets = engineAssetPaths(repoRoot);
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const jszipEsm = require.resolve("jszip/dist/jszip.min.js");
  const harness = await startOfficeHarness({
    prefix: "office-behavior-",
    pages: { "index.html": BEHAVIOR_PAGE },
    copies: {
      [assets.engine]: "ce/canvas-editor.js",
      [assets.docxPlugin]: "ce/docx.js",
      [assets.docxFixture]: "sample.docx",
      [assets.imageFixture]: "image.png",
      [jszipEsm]: "jszip.js",
    },
    // 调度器是 esbuild 现场打出来的，必须在页面加载前写好
    prepareDir: (dir) => bundleDispatcher(dir, editorDir),
  });
  const page = harness.page;

  const failures = [];
  const reload = async (withFixture = true) => {
    await page.evaluate((url) => window.__load(url), withFixture ? "/sample.docx" : null);
  };
  const run = async (name, args) =>
    page.evaluate(([command, commandArgs]) => window.__run(command, commandArgs), [name, args]);
  const state = async () => page.evaluate(() => window.__state());
  const elements = async () => page.evaluate(() => window.__elements());
  const check = (ok, message) => {
    if (ok) console.log(`ok   ${message}`);
    else {
      console.log(`FAIL ${message}`);
      failures.push(message);
    }
  };

  // ① 纸张大小：像素尺寸 + 页面还在（曾经传 "A4" 把尺寸写成 NaN，整页空白）
  for (const [label, expected] of [
    ["A3", { width: 1125, height: 1593 }],
    ["A5", { width: 565, height: 796 }],
    ["B5", { width: 665, height: 945 }],
    ["A4", { width: 794, height: 1123 }],
  ]) {
    await reload();
    await run("executePaperSize", [label]);
    const after = await state();
    const shot = await page.screenshot();
    check(
      after.width === expected.width && after.height === expected.height && shot.byteLength > 20000,
      `纸张 ${label}：尺寸 ${after.width}×${after.height}（期望 ${expected.width}×${expected.height}）· 截图 ${shot.byteLength} 字节`,
    );
  }

  // ② 六种控件各不相同（复选框/单选要有选项、日期要有日期格式）
  const controlShapes = {};
  for (const type of ["text", "select", "checkbox", "radio", "date", "number"]) {
    await reload(false);
    await run("executeInsertControlByType", [type]);
    const main = await elements();
    const control = main.find((element) => element?.type === "control")?.control;
    controlShapes[type] = JSON.stringify({
      type: control?.type,
      sets: control?.valueSets?.length ?? 0,
      date: control?.date?.dateFormat ?? null,
      placeholder: control?.placeholder ?? null,
    });
  }
  const distinct = new Set(Object.values(controlShapes));
  check(
    distinct.size === 6 &&
      controlShapes.checkbox.includes('"sets":2') &&
      controlShapes.date.includes("yyyy-MM-dd"),
    `六种控件形状互不相同（${distinct.size}/6 种）：${JSON.stringify(controlShapes)}`,
  );
  check(
    controlShapes.select.includes('"sets":2') && controlShapes.radio.includes('"sets":2'),
    "列举/单选框控件带选项（不再是空壳）",
  );

  // ②a 控件不再带 `{}` 花括号（引擎默认 prefix/postfix 就是它，Word 用的是浅色底纹）
  await reload(false);
  const controlOptions = await page.evaluate(() => {
    const options = window.__editor.command.getOptions();
    return {
      prefix: options.control?.prefix,
      postfix: options.control?.postfix,
    };
  });
  console.log(
    "    [debug] 各阶段 prefix：" +
      JSON.stringify(
        await page.evaluate(() => ({ ...window.__probe, created: window.__createdOptions })),
      ),
  );

  await run("executeInsertControlByType", ["text"]);
  const controlElements = await elements();
  const braceValues = controlElements
    .map((element) => element?.value)
    .filter((value) => value === "{" || value === "}");
  const recognised = controlElements.some((element) => element?.type === "control");
  check(
    controlOptions.prefix === "\u200b" &&
      controlOptions.postfix === "\u200b" &&
      braceValues.length === 0 &&
      recognised,
    `内容控件不带花括号、且仍能被识别（定界符＝零宽空格，花括号 ${braceValues.length} 个，控件元素存在 ${recognised}）`,
  );

  // ②b 复选框控件 / 日期控件两个按钮
  await reload(false);
  await run("executeInsertCheckboxControl");
  await run("executeInsertDateControl");
  const twoControls = (await elements()).filter((element) => element?.type === "control");
  check(
    twoControls.length === 2 &&
      twoControls[0]?.control?.type === "checkbox" &&
      twoControls[1]?.control?.type === "date",
    `复选框控件与日期控件都插得进去（${twoControls.map((element) => element.control?.type).join(" / ")}）`,
  );

  // ③ 分页 / 连页能来回切（曾经用 "continuous" 比对，切过去就回不来）
  await reload(false);
  await run("executePageMode");
  const afterFirst = await state();
  await run("executePageMode");
  const afterSecond = await state();
  check(
    afterFirst.pageMode === "continuity" && afterSecond.pageMode === "paging",
    `分页/连页可来回切换（${afterFirst.pageMode} → ${afterSecond.pageMode}）`,
  );

  // ④ 缩放：设 150% 后引擎真的变了，且能恢复 100%
  await reload(false);
  await run("executePageScale", [1.5]);
  const zoomed = await state();
  await run("executePageScale", [1]);
  const restored = await state();
  check(
    Math.abs(Number(zoomed.scale) - 1.5) < 0.001 && Math.abs(Number(restored.scale) - 1) < 0.001,
    `缩放可设到 ${zoomed.scale} 并恢复 ${restored.scale}（功能区的比例下拉读的就是它）`,
  );

  // 页眉页脚：源有则原样保留（含 logo 等侧车文件），源没有则不让插件默认页脚留下来
  const hfCases = await page.evaluate(() => window.__headerFooterCases());
  check(
    hfCases.plain.footerRefs === 0 && hfCases.plain.headerRefs === 0 && !hfCases.plain.footerText,
    `源文档没有页眉页脚时，导出的页脚被撤掉（引用 ${hfCases.plain.footerRefs}，部件 ${JSON.stringify(hfCases.plain.parts)}）`,
  );
  check(
    hfCases.withFooter.footerText.includes("FOOTER-MARK") && hfCases.withFooter.footerRefs === 1,
    `源文档有页脚时原样保留（${hfCases.withFooter.note}）`,
  );

  // 远端写能力探测：老远端（Method not found）要判"不能编辑"，新远端（版本不匹配）判"可以"
  const probes = await page.evaluate(async () => ({
    old: await window.__probeWrite("old-remote"),
    fresh: await window.__probeWrite("new-remote"),
    ok: await window.__probeWrite("writable"),
  }));
  check(
    probes.old.supported === false &&
      probes.fresh.supported === true &&
      probes.ok.supported === true,
    `写能力探测：老远端不支持（${probes.old.reason ?? ""}）／新远端支持／本地支持`,
  );

  // 缩放锚点：放大后视图不能跳回左上角；缩小到装得下时横向归零（交给 mx-auto 居中）
  const zoomCases = await page.evaluate(() => [
    window.__zoomScroll({
      scrollTop: 400,
      scrollLeft: 260,
      viewportWidth: 800,
      viewportHeight: 600,
      contentWidth: 1191,
      contentHeight: 6000,
      prevScale: 1,
      nextScale: 1.5,
    }),
    window.__zoomScroll({
      scrollTop: 400,
      scrollLeft: 260,
      viewportWidth: 1600,
      viewportHeight: 600,
      contentWidth: 794,
      contentHeight: 6000,
      prevScale: 1.5,
      nextScale: 1,
    }),
    window.__zoomScroll({
      scrollTop: 99999,
      scrollLeft: 99999,
      viewportWidth: 800,
      viewportHeight: 600,
      contentWidth: 1191,
      contentHeight: 1200,
      prevScale: 1,
      nextScale: 1.5,
    }),
  ]);
  const [zoomIn, zoomOut, zoomClamp] = zoomCases;
  check(
    zoomIn.scrollTop === 600 && zoomIn.scrollLeft === 390,
    `放大后滚动锚点按比例搬运（${JSON.stringify(zoomIn)}，期望 top 600 / left 390）`,
  );
  // 缩小：同一文档位置对应 scrollTop = 400 × (1 / 1.5) ≈ 266.7；横向因装得下而归零
  check(
    zoomOut.scrollLeft === 0 && Math.abs(zoomOut.scrollTop - 400 / 1.5) < 1,
    `缩小到装得下时横向归零、纵向换成同一文档位置（${JSON.stringify(zoomOut)}）`,
  );
  check(
    zoomClamp.scrollTop === 600 && zoomClamp.scrollLeft === 391,
    `滚动位置被夹在内容范围内（${JSON.stringify(zoomClamp)}）`,
  );

  // ⑤ 字数统计 / 查找 / 替换 / 公式 / 表格
  await reload();
  // 字数统计是异步的（引擎用 worker 数），状态栏消息晚于命令返回，所以等一拍再读
  await run("executeWordCount");
  await page.waitForTimeout(500);
  const wordCount = await page.evaluate(() => ({ messages: window.__lastMessages }));
  check(
    wordCount.messages.some((message) => /字数 \d+/.test(message)),
    `字数统计给出结果：${wordCount.messages.join(" | ").slice(0, 80)}`,
  );

  const find = await run("executeFind", ["压测"]);
  const findNext = await run("executeFindNext", ["压测"]);
  check(
    find.messages.some((message) => /第 1 \/ 共 \d+ 处/.test(message)) &&
      findNext.messages.some((message) => /第 2 \/ 共 \d+ 处/.test(message)),
    `查找可定位并推进：${find.messages.join("")} → ${findNext.messages.join("")}`,
  );

  console.log();
  const beforeReplace = (await state()).text;
  const replaced = await run("executeReplaceAll", ["压测", "压测证"]);
  const afterReplace = (await state()).text;
  check(
    replaced.messages.some((message) => /已替换 \d+ 处/.test(message)) &&
      afterReplace.includes("压测证") &&
      afterReplace.length > beforeReplace.length,
    `替换真的改到文档（${beforeReplace.length} → ${afterReplace.length} 字符）：${replaced.messages.join("")}`,
  );

  // 单字关键词（选区换算与关键词长度有关，单独验一遍）
  await reload();
  const beforeSingle = (await state()).text;
  const replacedSingle = await run("executeReplaceAll", ["段", "节"]);
  const afterSingle = (await state()).text;
  check(
    replacedSingle.messages.some((message) => /已替换 \d+ 处/.test(message)) &&
      afterSingle.includes("节") &&
      afterSingle.length === beforeSingle.length,
    `单字替换可用（${beforeSingle.length} 字符 → ${afterSingle.length}）：${replacedSingle.messages.join("")}`,
  );

  await reload(false);
  await run("executeLatex", ["E=mc^2"]);
  const latex = (await elements()).find((element) => element?.type === "latex");
  // 引擎自己把 LaTeX 源码转成 SVG（convertLaTextToSVG），插进去的宽高由它算——所以断言"有盒子"
  check(
    Boolean(latex && Number(latex.width) > 0 && Number(latex.height) > 0),
    `公式插成 latex 元素并算出了盒子（${latex?.width}×${latex?.height}）`,
  );

  await reload(false);
  await run("executeInsertTable", [3, 4]);
  const table = (await elements()).find((element) => element?.type === "table");
  check(
    table?.trList?.length === 3 && table?.trList?.[0]?.tdList?.length === 4,
    `表格 3×4 插出来是 ${table?.trList?.length}×${table?.trList?.[0]?.tdList?.length}`,
  );

  // 打印：引擎会把每页渲染成图片塞进隐藏 iframe 再 print()。无头里 print 是空操作，
  // 所以这里断言"打印路径真的跑起来并建了打印 iframe"——对话框是否弹出只能真机看。
  await reload();
  const printResult = await page.evaluate(async () => {
    const before = document.querySelectorAll("iframe").length;
    const promise = window.__editor.command.executePrint();
    const settled = await Promise.race([
      promise.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 3000)),
    ]);
    return { settled, before, after: document.querySelectorAll("iframe").length };
  });
  check(
    printResult.settled === "resolved" && printResult.after > printResult.before,
    `打印路径跑通（${printResult.settled}，打印 iframe ${printResult.before} → ${printResult.after}）`,
  );

  // 护栏：含修订/超链接/公式/批注的文档必须先被识别，归一化后**文字不丢**
  const trickyDocx = await buildTrickyDocx();
  const preflight = await page.evaluate(async (bytes) => {
    const result = await window.__preflight.preprocessDocx(bytes);
    return {
      findings: result.findings,
      changes: result.changes,
      bytes: Array.from(new Uint8Array(result.bytes)),
    };
  }, Array.from(trickyDocx));
  const f = preflight.findings;
  check(
    f.revisions.inserted === 1 &&
      f.revisions.deleted === 1 &&
      f.hyperlinks === 1 &&
      f.formulas === 1 &&
      f.comments === 1,
    `预检认出文档特性：插入 ${f.revisions.inserted} / 删除 ${f.revisions.deleted} / 超链接 ${f.hyperlinks} / 公式 ${f.formulas} / 批注 ${f.comments}`,
  );
  check(
    preflight.changes.length >= 4,
    `预检给出了会说清楚的改动清单（${preflight.changes.length} 条，例：${preflight.changes[0] ?? ""}）`,
  );
  await page.evaluate(
    (bytes) => window.__loadPreprocessed(new Uint8Array(bytes).buffer),
    preflight.bytes,
  );
  const trickyText = (await state()).text;
  check(
    trickyText.includes("INSERTED") &&
      trickyText.includes("LINKTEXT") &&
      trickyText.includes("E=mc^2"),
    `归一化后插入文字/超链接文字/公式文字都还在（文本：${JSON.stringify(trickyText.slice(0, 80))}）`,
  );
  check(!trickyText.includes("DELETED"), "被删除的文字没有复活（w:del 按「接受删除」处理）");

  // 插入图片（从本机选文件＝data URI）：元素、尺寸、导出都要对
  await reload(false);
  const imageUri = await page.evaluate(() => window.__imageDataUri("/image.png"));
  check(
    typeof imageUri === "string" && imageUri.startsWith("data:image/png;base64,"),
    `样本图片读成 data URI（${String(imageUri).slice(0, 24)}…，${String(imageUri).length} 字符）`,
  );
  const beforeImage = await page.screenshot();
  await run("executeImage", [imageUri]);
  await page.waitForTimeout(200);
  const imageElement = (await elements()).find((element) => element?.type === "image");
  const afterImage = await page.screenshot();
  check(
    Boolean(imageElement) && imageElement.width === 240 && imageElement.height === 120,
    `图片按原图尺寸插入（240×120，实际 ${imageElement?.width}×${imageElement?.height}）`,
  );
  check(
    afterImage.byteLength !== beforeImage.byteLength,
    `插入图片后画布重绘（截图 ${beforeImage.byteLength} → ${afterImage.byteLength} 字节）`,
  );
  const exported = await page.evaluate(() => window.__exportDocx());
  check(
    exported > 60000,
    `导出的 docx 里带上了图片（${Math.round(exported / 1024)} KiB ≥ 样本 59 KiB）`,
  );

  // 版面撤销：分栏/纸张改动不在引擎的撤销栈里（引擎只存元素表），我们自己记快照
  await reload(false);
  const columnsOf = () => page.evaluate(() => window.__editor.command.getColumns());
  const beforeColumns = await columnsOf();
  await run("executeSetColumns", [{ count: 2, gap: 30, separator: false }]);
  const withColumns = await columnsOf();
  await run("executeUndo");
  const afterUndo = await columnsOf();
  check(
    withColumns?.count === 2 && afterUndo?.count !== 2,
    `分栏可撤销（${JSON.stringify(beforeColumns)} → 两栏 ${JSON.stringify(withColumns)} → 撤销后 ${JSON.stringify(afterUndo)}）`,
  );

  await reload(false);
  const beforePaper = await state();
  await run("executePaperSize", ["A3"]);
  const withPaper = await state();
  await run("executeUndo");
  const afterPaperUndo = await state();
  check(
    withPaper.width === 1125 &&
      afterPaperUndo.width === beforePaper.width &&
      afterPaperUndo.height === beforePaper.height,
    `纸张改动可撤销（${beforePaper.width}×${beforePaper.height} → ${withPaper.width}×${withPaper.height} → ${afterPaperUndo.width}×${afterPaperUndo.height}）`,
  );

  // 引擎没有这条命令时要明确报出来，不能静默无反应
  await reload(false);
  const unknown = await run("executeNotARealCommand");
  check(
    unknown.messages.some((message) => message.includes("不可用")),
    `未知命令会明确提示：${unknown.messages.join("")}`,
  );

  const shot = await page.screenshot();
  writeFileSync(join(harness.dir, "behavior.png"), shot);
  await harness.close();

  console.log(`\n失败 ${failures.length} 条`);
  for (const failure of failures) console.log("FAIL", failure);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
