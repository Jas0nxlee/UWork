/**
 * 行为检查的**页面脚手架**：esbuild 现场打的调度器 + 页面 HTML。
 *
 * 抽出来的原因：脚本本体要守 400 行上限；这些东西与"检查什么"无关，只是把我们的模块
 * 装进浏览器（用编辑位同一份构造参数，所以观感约定也在回归范围内）。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CASE_SNIPPETS } from "./officeCaseSnippets.mjs";

export const BEHAVIOR_PAGE = `<!doctype html><meta charset="utf-8">
<div id="host" style="height:100vh;overflow:auto"></div>
<script src="/jszip.js"></script>
<script type="importmap">{"imports":{"@hufe921/canvas-editor":"/ce/canvas-editor.js"}}</script>
<script type="module">
  import Editor from "/ce/canvas-editor.js";
  import docxPlugin from "/ce/docx.js";
  import { layoutBalloons, scrollTopForRect } from "/dispatcher.js";
  import { probeWriteSupport, preserveHeaderFooter, applyTrackedChanges, acceptedText, rejectedText, applyRevisionView, restoreRevisions, buildRevisionView, listRevisions, resolveRevisions, removeCommentAnchorsInDocx, stripCommentsFromPreservation } from "/dispatcher.js";
  import { runEngineCommand, createFindSession, createLayoutHistory, createEditorOptions, createInitialData, documentText, scrollAfterZoom, preprocessDocx, analyzeDocumentXml, normalizeDocumentXml, summarizeFindings } from "/dispatcher.js";

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

  window.__preflight = { preprocessDocx, analyzeDocumentXml, normalizeDocumentXml, summarizeFindings };
  /**
   * 审阅（Word 的接受/拒绝）：枚举 → 逐条处理 → 全部处理，断言每步的剩余数与文字结果。
   */
  window.__reviewCase = () => {
    const XMLNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const document =
      '<w:document ' + XMLNS + '><w:body>' +
      '<w:p><w:r><w:t>AAA</w:t></w:r><w:ins w:id="1" w:author="A"><w:r><w:t>INS1</w:t></w:r></w:ins>' +
      '<w:del w:id="2" w:author="B"><w:r><w:delText>DEL2</w:delText></w:r></w:del></w:p>' +
      '<w:p><w:ins w:id="3" w:author="A"><w:r><w:t>INS3</w:t></w:r></w:ins></w:p>' +
      '</w:body></w:document>';
    const api = window.__trackedApi;
    const all = api.listRevisions(document);
    const acceptOne = api.resolveRevisions(document, { action: "accept", targetIndex: 0 });
    const rejectOne = api.resolveRevisions(document, { action: "reject", targetIndex: 1 });
    const acceptAll = api.resolveRevisions(document, { action: "accept" });
    const rejectAll = api.resolveRevisions(document, { action: "reject" });
    return {
      listed: all.map((item) => item.kind + ":" + item.text),
      acceptOneRemaining: acceptOne.remaining.length,
      acceptOneText: acceptOne.xml,
      rejectOneRemaining: rejectOne.remaining.length,
      rejectOneText: rejectOne.xml,
      acceptAllText: acceptAll.xml,
      rejectAllText: rejectAll.xml,
    };
  };

  /**
   * 批注的**引擎侧**能力（官方 demo 用的那套）：选中锚点文字 → executeSetGroup →
   * getGroupRectList 拿矩形 → executeLocationGroup 定位 → executeDeleteGroup 删除。
   */
  window.__commentGroupCase = async () => {
    await window.__load(null);
    const editor = window.__editor;
    const commands = editor.command;
    commands.executeInsertElementList([{ value: "被批注的一句话 后面还有字" }]);
    const ranges = commands.getKeywordRangeList("被批注的一句话");
    const range = ranges && ranges[0];
    if (!range) return { error: "找不到锚点文字" };
    commands.executeReplaceRange({ ...range, startIndex: Math.max(0, range.startIndex - 1), endIndex: range.endIndex });
    const groupId = commands.executeSetGroup();
    const ids = await commands.getGroupIds();
    const rectList = commands.getGroupRectList(groupId);
    commands.executeLocationGroup(groupId);
    const rectAfterLocate = commands.getGroupRectList(groupId);
    commands.executeDeleteGroup(groupId);
    const idsAfterDelete = await commands.getGroupIds();
    return {
      groupId: typeof groupId === "string" && groupId.length > 0,
      inIdList: Array.isArray(ids) && ids.includes(groupId),
      rects: Array.isArray(rectList) ? rectList.length : 0,
      rectAfterLocate: Array.isArray(rectAfterLocate) ? rectAfterLocate.length : 0,
      deleted: Array.isArray(idsAfterDelete) ? idsAfterDelete.length === 0 : false,
    };
  };

  /**
   * 删除批注：正文不动，但字节层要真的去掉这条的锚点，且**段落原件**也要同步
   * （否则保存时 restoreRevisions 会把锚点原样写回去，表现就是"删不掉"）。
   */
  window.__deleteCommentCase = async () => {
    const XMLNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const zip = new window.JSZip();
    zip.file("word/document.xml",
      '<w:document ' + XMLNS + '><w:body>' +
      '<w:p><w:commentRangeStart w:id="7"/><w:r><w:t>第一条锚点</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>' +
      '<w:p><w:commentRangeStart w:id="8"/><w:r><w:t>第二条锚点</w:t></w:r><w:commentRangeEnd w:id="8"/><w:r><w:commentReference w:id="8"/></w:r></w:p>' +
      '</w:body></w:document>');
    const source = await zip.generateAsync({ type: "arraybuffer" });
    const view = await window.__trackedApi.applyRevisionView(source);
    const afterDelete = await window.__trackedApi.removeCommentAnchorsInDocx(view.bytes, ["7"]);
    const preserved = window.__trackedApi.stripCommentsFromPreservation(view.preservation, ["7"]);
    const zipAfter = await window.JSZip.loadAsync(afterDelete.bytes);
    const xml = await zipAfter.file("word/document.xml").async("string");
    return {
      removed: afterDelete.removed,
      goneFirst: !xml.includes('w:id="7"'),
      keepSecond: xml.includes('w:id="8"'),
      bodyKept: xml.includes("第一条锚点") && xml.includes("第二条锚点"),
      preservationGoneFirst: !preserved.paragraphs[0].originalXml.includes('w:id="7"'),
      preservationKeepSecond: preserved.paragraphs[1].originalXml.includes('w:id="8"'),
      commentsLeft: preserved.comments.length,
    };
  };

  /** 批注解析：comments.xml 的作者/时间/内容要与正文里的 [n] 标记对上。 */
  window.__commentCase = async () => {
    const XMLNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const zip = new window.JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>');
    // Word 的锚定方式：commentRangeStart → 被批注的文字 → commentRangeEnd → 引用
    zip.file("word/document.xml",
      '<w:document ' + XMLNS + '><w:body>' +
      '<w:p><w:commentRangeStart w:id="7"/><w:r><w:t>被批注的一句话</w:t></w:r><w:commentRangeEnd w:id="7"/>' +
      '<w:r><w:commentReference w:id="7"/></w:r></w:p>' +
      '<w:p><w:commentRangeStart w:id="8"/><w:r><w:t>第二处锚点</w:t></w:r><w:commentRangeEnd w:id="8"/>' +
      '<w:r><w:commentReference w:id="8"/></w:r></w:p>' +
      '</w:body></w:document>');
    zip.file("word/comments.xml",
      '<w:comments ' + XMLNS + '>' +
      '<w:comment w:id="7" w:author="张审阅" w:date="2026-10-16T09:00:00Z"><w:p><w:r><w:t>这里要改</w:t></w:r></w:p></w:comment>' +
      '<w:comment w:id="8" w:author="李审阅" w:date="2026-10-16T10:00:00Z"><w:p><w:r><w:t>这句不通</w:t></w:r></w:p></w:comment>' +
      '</w:comments>');
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    const view = await window.__trackedApi.applyRevisionView(bytes);
    const zip2 = await window.JSZip.loadAsync(view.bytes);
    const documentXml = await zip2.file("word/document.xml").async("string");
    return {
      count: view.comments.length,
      authors: view.comments.map((c) => c.author),
      texts: view.comments.map((c) => c.text),
      paragraphs: view.comments.map((c) => c.paragraph),
      anchors: view.comments.map((c) => c.anchorText),
      // 锚点加了浅底纹（Word 的批注底色），且正文里**不再**注入自造标记
      bodyShaded: documentXml.includes("FFF7D6"),
      bodyHasInventedMarker: documentXml.includes("[1]"),
    };
  };

  window.__trackedApi = {
    applyTrackedChanges,
    acceptedText,
    rejectedText,
    applyRevisionView,
    restoreRevisions,
    buildRevisionView,
    listRevisions,
    resolveRevisions,
    removeCommentAnchorsInDocx,
    stripCommentsFromPreservation,
  };

  /**
   * 修订的"正文内显示 + 保存写回"：① 插入文字着色下划线、删除文字红色删除线、批注变上标标记；
   * ② 保存时未编辑的段落换回原件（w:ins/w:del/commentReference 都在）。
   */
  window.__revisionViewCase = async () => {
    const XMLNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const document =
      '<w:document ' + XMLNS + '><w:body>' +
      '<w:p><w:r><w:t>AAA 普通正文</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>BBB</w:t></w:r><w:ins w:id="1" w:author="审阅者"><w:r><w:t>INSERTED</w:t></w:r></w:ins><w:r><w:t>CCC</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>DDD</w:t></w:r><w:del w:id="2" w:author="审阅者"><w:r><w:delText>DELETED</w:delText></w:r></w:del><w:r><w:t>EEE</w:t></w:r></w:p>' +
      '<w:p><w:commentRangeStart w:id="3"/><w:r><w:t>被批注的文字</w:t></w:r><w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r></w:p>' +
      '</w:body></w:document>';
    const zip = new window.JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("word/document.xml", document);
    const sourceBytes = await zip.generateAsync({ type: "arraybuffer" });

    const view = await window.__trackedApi.applyRevisionView(sourceBytes);
    const viewZip = await window.JSZip.loadAsync(view.bytes);
    const viewXml = await viewZip.file("word/document.xml").async("string");
    // 用我们自己的归一化把它导进引擎，看正文里显示了什么
    const engine = await window.__preflight.normalizeDocumentXml(viewXml);
    // 保存路径：导出（这里用同一份"显示版"模拟用户没编辑）→ 写回原件
    const saved = await window.__trackedApi.restoreRevisions(view.bytes, view.preservation);
    const savedZip = await window.JSZip.loadAsync(saved.bytes);
    const savedXml = await savedZip.file("word/document.xml").async("string");
    return {
      summary: view.summary,
      engineText: engine.xml,
      bodyShowsInserted: /INSERTED/.test(viewXml),
      insertedUnderlined: new RegExp('<w:u w:val="single"/>').test(viewXml) && viewXml.includes("1A73E8"),
      deletedStruck: new RegExp("<w:strike/>").test(viewXml) && viewXml.includes("D93025"),
      commentShaded: viewXml.includes("FFF7D6"),
      savedHasIns: new RegExp("<w:ins[ >]").test(savedXml),
      savedHasDel: new RegExp("<w:del[ >]").test(savedXml),
      savedHasCommentRef: new RegExp("<w:commentReference[ >]").test(savedXml),
      restored: saved.restored,
      edited: saved.edited,
    };
  };

${CASE_SNIPPETS}
  /** 审阅导航的滚动判定（纯函数）：视野内不动、超出才滚、按缩放换算。 */
  window.__navScrollCase = () => ({
    inside: scrollTopForRect({ rect: { y: 1000, height: 20 }, scale: 1, scrollTop: 900, viewportHeight: 600 }),
    below: scrollTopForRect({ rect: { y: 1700, height: 20 }, scale: 1, scrollTop: 900, viewportHeight: 600 }),
    above: scrollTopForRect({ rect: { y: 100, height: 20 }, scale: 1, scrollTop: 900, viewportHeight: 600 }),
    zoomed: scrollTopForRect({ rect: { y: 500, height: 20 }, scale: 1.5, scrollTop: 0, viewportHeight: 600 }),
  });

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
      `export { preprocessDocx, analyzeDocumentXml, normalizeDocumentXml, summarizeFindings } from ${JSON.stringify(join(editorDir, "docxPreflight.ts"))};`,
      `export { probeWriteSupport } from ${JSON.stringify(join(editorDir, "fileWriteSupport.ts"))};`,
      `export { preserveHeaderFooter } from ${JSON.stringify(join(editorDir, "docxHeaderFooter.ts"))};`,
      `export { applyTrackedChanges, acceptedText, rejectedText } from ${JSON.stringify(join(editorDir, "docxTrackChanges.ts"))};`,
      `export { applyRevisionView, restoreRevisions, buildRevisionView, removeCommentAnchorsInDocx, stripCommentsFromPreservation } from ${JSON.stringify(join(editorDir, "docxRevisions.ts"))};`,
      `export { listRevisions, resolveRevisions } from ${JSON.stringify(join(editorDir, "docxReview.ts"))};`,
      `export { layoutBalloons } from ${JSON.stringify(join(editorDir, "commentBalloons.ts"))};`,
      `export { scrollTopForRect } from ${JSON.stringify(join(editorDir, "officeReviewNavigation.ts"))};`,
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
