/**
 * 行为检查的**页面脚手架**：esbuild 现场打的调度器 + 页面 HTML。
 *
 * 抽出来的原因：脚本本体要守 400 行上限；这些东西与"检查什么"无关，只是把我们的模块
 * 装进浏览器（用编辑位同一份构造参数，所以观感约定也在回归范围内）。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const BEHAVIOR_PAGE = `<!doctype html><meta charset="utf-8">
<div id="host" style="height:100vh;overflow:auto"></div>
<script type="importmap">{"imports":{"@hufe921/canvas-editor":"/ce/canvas-editor.js"}}</script>
<script type="module">
  import Editor from "/ce/canvas-editor.js";
  import docxPlugin from "/ce/docx.js";
  import { runEngineCommand, createFindSession, createLayoutHistory, createEditorOptions, createInitialData, documentText, scrollAfterZoom, preprocessDocx, analyzeDocumentXml, normalizeDocumentXml } from "/dispatcher.js";

  window.__load = async (url) => {
    document.getElementById("host").replaceChildren();
    const host = document.getElementById("host");
    // 用与编辑位同一份构造选项：这样"控件没有花括号"这类观感约定也在回归范围内
    const editor = new Editor(host, createInitialData(), createEditorOptions({ scrollContainerSelector: "#host" }));
    editor.use(docxPlugin);
    if (url) await editor.command.executeImportDocx({ arrayBuffer: await (await fetch(url)).arrayBuffer() });
    // 程序化插入需要游标（引擎在无 range 时直接不插）
    editor.command.executeSetRange(0, 0);
    window.__editor = editor;
    window.__findRef = { current: createFindSession() };
    window.__layoutRef = { current: createLayoutHistory() };
    window.__engineState = { mode: "edit", pageMode: "paging" };
    // 引擎的撤销可用性由编辑位从 rangeStyleChange 回填；这里固定成"引擎没得撤"，
    // 用来验证"版面改动能否被撤销"
    window.__engineUndo = { canUndo: false, canRedo: false };
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
          layoutRef: window.__layoutRef,
          canUndoEngine: () => window.__engineUndo.canUndo,
          canRedoEngine: () => window.__engineUndo.canRedo,
        },
        name,
        args,
      );
    } catch (error) {
      return { error: String(error).slice(0, 200), messages };
    }
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

  window.__preflight = { preprocessDocx, analyzeDocumentXml, normalizeDocumentXml };

  /** 缩放后的滚动锚点（纯函数，见 pageViewport.ts）。 */
  window.__zoomScroll = (input) => scrollAfterZoom(input);

  /** 预处理（护栏）后的字节直接给引擎导入，用于验证"归一化后文字不丢"。 */
  window.__loadPreprocessed = async (bytes) => {
    document.getElementById("host").replaceChildren();
    const editor = new Editor(document.getElementById("host"), createInitialData(), createEditorOptions({ scrollContainerSelector: "#host" }));
    editor.use(docxPlugin);
    await editor.command.executeImportDocx({ arrayBuffer: bytes });
    editor.command.executeSetRange(0, 0);
    window.__editor = editor;
    window.__findRef = { current: createFindSession() };
    window.__layoutRef = { current: createLayoutHistory() };
    window.__engineUndo = { canUndo: false, canRedo: false };
    return true;
  };

  /** 把服务端的图片转成 data URI：与"从本机选文件"读出来的形态完全一致。 */
  window.__imageDataUri = async (url) => {
    const blob = await (await fetch(url)).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  };

  /** 导出 docx（图片是否真的进了文件，用导出产物大小判断）。 */
  window.__exportDocx = async () => {
    // 与编辑位一致：插件把导出注册在 command 上
    const blob = await window.__editor.command.executeExportDocx({ fileName: "check.docx" });
    return blob.size;
  };
</script>`;

/** 把我们自己的调度器打成浏览器模块（入口在临时目录，用一层再导出把两个模块聚成一个 URL）。 */
export async function bundleDispatcher(dir, editorDir) {
  const esbuild = await import("esbuild");
  const entry = join(dir, "dispatcher-entry.ts");
  writeFileSync(
    entry,
    [
      `export { runEngineCommand, createFindSession } from ${JSON.stringify(join(editorDir, "officeEditorCommands.ts"))};`,
      `export { createLayoutHistory } from ${JSON.stringify(join(editorDir, "engineLayoutHistory.ts"))};`,
      `export { documentText } from ${JSON.stringify(join(editorDir, "engineCommands.ts"))};`,
      `export { createEditorOptions, createInitialData } from ${JSON.stringify(join(editorDir, "officeEditorOptions.ts"))};`,
      `export { scrollAfterZoom } from ${JSON.stringify(join(editorDir, "pageViewport.ts"))};`,
      `export { preprocessDocx, analyzeDocumentXml, normalizeDocumentXml } from ${JSON.stringify(join(editorDir, "docxPreflight.ts"))};`,
    ].join("\n"),
    "utf8",
  );
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    absWorkingDir: process.cwd(),
    define: { "process.env.NODE_ENV": '"production"' },
  });
  writeFileSync(join(dir, "dispatcher.js"), result.outputFiles[0].text, "utf8");
}
