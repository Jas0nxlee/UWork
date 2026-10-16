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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");
const fixture = join(repoRoot, "packages/ui/test/fixtures/office-editor-check.docx");

const HARNESS = `<!doctype html><meta charset="utf-8">
<div id="host" style="height:100vh;overflow:auto"></div>
<script type="importmap">{"imports":{"@hufe921/canvas-editor":"/ce/canvas-editor.js"}}</script>
<script type="module">
  import Editor from "/ce/canvas-editor.js";
  import docxPlugin from "/ce/docx.js";
  import { runEngineCommand, createFindSession, documentText } from "/dispatcher.js";

  window.__load = async (url) => {
    document.getElementById("host").replaceChildren();
    const host = document.getElementById("host");
    const editor = new Editor(host, { main: [{ value: "" }], pageMode: "paging", margins: [100, 120, 100, 120], scrollContainerSelector: "#host" });
    editor.use(docxPlugin);
    if (url) await editor.command.executeImportDocx({ arrayBuffer: await (await fetch(url)).arrayBuffer() });
    editor.command.executeSetRange(0, 0);
    window.__editor = editor;
    window.__findRef = { current: createFindSession() };
    window.__engineState = { mode: "edit", pageMode: "paging" };
    return true;
  };

  /** 走**我们自己的**命令调度（officeEditorCommands.ts），并把状态栏消息带回来。 */
  window.__run = (name, args) => {
    const messages = [];
    window.__lastMessages = messages;
    try {
      runEngineCommand(
        {
          editor: window.__editor,
          commands: window.__editor.command,
          status: (message) => messages.push(message),
          engineState: window.__engineState,
          findRef: window.__findRef,
        },
        name,
        args,
      );
    } catch (error) {
      return { error: String(error).slice(0, 200), messages };
    }
    // 同步我们维护的引擎状态（真机上由编辑位的 syncLayoutState 做同样的事）
    const options = window.__editor.command.getOptions();
    window.__engineState.mode = options.mode;
    window.__engineState.pageMode = options.pageMode;
    return { messages };
  };

  window.__state = () => {
    const options = window.__editor.command.getOptions();
    return {
      width: options.width,
      height: options.height,
      scale: options.scale,
      mode: options.mode,
      pageMode: options.pageMode,
      traceDisabled: options.trace?.disabled,
      text: documentText(window.__editor.command.getValue().data),
    };
  };

  window.__elements = () => window.__editor.command.getValue().data.main;
</script>`;

async function bundleDispatcher(dir) {
  const esbuild = await import("esbuild");
  // 入口写在临时目录里：页面要用的东西分散在两个模块（调度 + 参数工具），用一层再导出把它们聚成
  // 一个 URL，避免为每个模块各写一段 importmap。
  const entry = join(dir, "dispatcher-entry.ts");
  writeFileSync(
    entry,
    [
      `export { runEngineCommand, createFindSession } from ${JSON.stringify(join(editorDir, "officeEditorCommands.ts"))};`,
      `export { documentText } from ${JSON.stringify(join(editorDir, "engineCommands.ts"))};`,
    ].join("\n"),
    "utf8",
  );
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    absWorkingDir: repoRoot,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  writeFileSync(join(dir, "dispatcher.js"), result.outputFiles[0].text, "utf8");
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.error("缺少 playwright-core：先 pnpm install");
    return 1;
  }
  const dir = mkdtempSync(join(tmpdir(), "office-behavior-"));
  await mkdir(join(dir, "ce"), { recursive: true });
  writeFileSync(join(dir, "index.html"), HARNESS, "utf8");
  const { cp } = await import("node:fs/promises");
  await cp(
    join(repoRoot, "node_modules/@hufe921/canvas-editor/dist/canvas-editor.js"),
    join(dir, "ce/canvas-editor.js"),
  );
  await cp(
    join(repoRoot, "node_modules/@hufe921/canvas-editor-plugin-docx/dist/docx.js"),
    join(dir, "ce/docx.js"),
  );
  await cp(fixture, join(dir, "sample.docx"));
  await bundleDispatcher(dir);

  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    try {
      const body = readFileSync(join(dir, path === "/" ? "index.html" : path));
      response.writeHead(200, {
        "content-type": path.endsWith(".html")
          ? "text/html"
          : path.endsWith(".docx")
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : "text/javascript",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const port = server.address().port;

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.OFFICE_CHECK_CHROMIUM
      ? { executablePath: process.env.OFFICE_CHECK_CHROMIUM }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`);

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

  // 引擎没有这条命令时要明确报出来，不能静默无反应
  await reload(false);
  const unknown = await run("executeNotARealCommand");
  check(
    unknown.messages.some((message) => message.includes("不可用")),
    `未知命令会明确提示：${unknown.messages.join("")}`,
  );

  const shot = await page.screenshot();
  writeFileSync(join(dir, "behavior.png"), shot);
  await browser.close();
  server.close();

  console.log(`\n失败 ${failures.length} 条`);
  for (const failure of failures) console.log("FAIL", failure);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
