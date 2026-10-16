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
<script src="/jszip.js"></script>
<script type="importmap">{"imports":{"@hufe921/canvas-editor":"/ce/canvas-editor.js"}}</script>
<script type="module">
  import Editor from "/ce/canvas-editor.js";
  import docxPlugin from "/ce/docx.js";
  import { probeWriteSupport, preserveHeaderFooter, applyTrackedChanges, acceptedText, rejectedText, applyRevisionView, restoreRevisions, buildRevisionView, listRevisions, resolveRevisions } from "/dispatcher.js";
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

  window.__trackedApi = {
    applyTrackedChanges,
    acceptedText,
    rejectedText,
    applyRevisionView,
    restoreRevisions,
    buildRevisionView,
    listRevisions,
    resolveRevisions,
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
      '<w:p><w:r><w:t>被批注的文字</w:t></w:r><w:r><w:commentReference w:id="3"/></w:r></w:p>' +
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
      commentMark: viewXml.includes("[1]"),
      savedHasIns: new RegExp("<w:ins[ >]").test(savedXml),
      savedHasDel: new RegExp("<w:del[ >]").test(savedXml),
      savedHasCommentRef: new RegExp("<w:commentReference[ >]").test(savedXml),
      restored: saved.restored,
      edited: saved.edited,
    };
  };

  /**
   * 修订模式用例：基线文档 → "编辑后"文档（改一段、加一段、删一段）→ 落成 w:ins/w:del。
   * 判据：接受全部修订 == 编辑后的样子；拒绝全部修订 == 基线（与 Word 口径一致）。
   */
  window.__trackChangesCase = async () => {
    const XMLNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const paragraph = (text) => '<w:p><w:r><w:t xml:space="preserve">' + text + '</w:t></w:r></w:p>';
    const doc = (paragraphs) => '<w:document ' + XMLNS + '><w:body>' + paragraphs.join("") + '</w:body></w:document>';
    // applyTrackedChanges 收的是 **docx（zip）字节**：这里现场打两个最小 zip
    const zipOf = async (documentXml) => {
      const zip = new window.JSZip();
      zip.file(
        "[Content_Types].xml",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      );
      zip.file("word/document.xml", documentXml);
      return await zip.generateAsync({ type: "arraybuffer" });
    };
    const baseline = doc([paragraph("第一段原样"), paragraph("第二段要改旧内容"), paragraph("第三段要删")]);
    const edited = doc([paragraph("第一段原样"), paragraph("第二段要改新内容"), paragraph("新增的一段")]);
    const result = await window.__trackedApi.applyTrackedChanges(await zipOf(baseline), await zipOf(edited), {
      author: "UWork",
      date: "2026-10-16T00:00:00.000Z",
    });
    const zip = await window.JSZip.loadAsync(result.bytes);
    const xml = await zip.file("word/document.xml").async("string");
    return {
      stats: result.stats,
      hasIns: new RegExp("<w:ins[ >]").test(xml),
      hasDel: new RegExp("<w:del[ >]").test(xml),
      hasDelText: new RegExp("<w:delText").test(xml),
      accepted: window.__trackedApi.acceptedText(xml),
      rejected: window.__trackedApi.rejectedText(xml, baseline),
      editedText: ["第一段原样", "第二段要改新内容", "新增的一段"].join("\\n"),
      baselineText: ["第一段原样", "第二段要改旧内容", "第三段要删"].join("\\n"),
    };
  };

  /**
   * 页眉页脚用例：造"源无页脚"与"源有页脚"两份文档，各走一次 preserveHeaderFooter，
   * 与"插件导出（总带自己的 PAGE 页脚）"对比。
   */
  window.__headerFooterCases = async () => {
    const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const XMLNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const CONTENT_TYPES_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>';
    const FOOTER_OVERRIDE = '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>';
    const HEADER_OVERRIDE = '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>';

    const buildSource = async (withFooter) => {
      const zip = new window.JSZip();
      zip.file("[Content_Types].xml", CONTENT_TYPES_HEAD + (withFooter ? FOOTER_OVERRIDE : "") + "</Types>");
      zip.file("word/document.xml", '<w:document ' + XMLNS + '><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>');
      if (withFooter)
        zip.file("word/footer1.xml", '<w:ftr ' + XMLNS + '><w:p><w:r><w:t>公司页脚 FOOTER-MARK</w:t></w:r></w:p></w:ftr>');
      return new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }));
    };
    // 模拟插件导出：总带自己的页眉页脚
    const exportZip = new window.JSZip();
    exportZip.file("[Content_Types].xml", CONTENT_TYPES_HEAD + FOOTER_OVERRIDE + HEADER_OVERRIDE + "</Types>");
    exportZip.file(
      "word/document.xml",
      '<w:document ' + XMLNS + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rId6"/><w:footerReference w:type="default" r:id="rId7"/></w:sectPr></w:body></w:document>',
    );
    exportZip.file("word/footer1.xml", '<w:ftr ' + XMLNS + '><w:p><w:r><w:t>PAGE</w:t></w:r></w:p></w:ftr>');
    exportZip.file("word/header1.xml", '<w:hdr ' + XMLNS + '><w:p/></w:hdr>');
    const exported = encode(new Uint8Array(await exportZip.generateAsync({ type: "arraybuffer" })));

    return {
      plain: await window.__preserveHeaderFooter(encode(await buildSource(false)), exported),
      withFooter: await window.__preserveHeaderFooter(encode(await buildSource(true)), exported),
    };
  };

  /** 页眉页脚保留：给源文档与导出文档的字节，返回处理后的 zip 结构摘要。 */
  window.__preserveHeaderFooter = async (sourceB64, exportedB64) => {
    const toBuffer = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const result = await preserveHeaderFooter(toBuffer(sourceB64), toBuffer(exportedB64));
    const zip = await window.JSZip.loadAsync(result.bytes);
    const document = await zip.file("word/document.xml")?.async("string");
    const footer = await zip.file("word/footer1.xml")?.async("string");
    return {
      note: result.note,
      parts: Object.keys(zip.files).filter((n) => new RegExp("word/(header|footer)[0-9]*[.]xml$").test(n)),
      headerRefs: (document?.match(new RegExp("<w:headerReference", "g")) ?? []).length,
      footerRefs: (document?.match(new RegExp("<w:footerReference", "g")) ?? []).length,
      footerText: footer ?? "",
    };
  };

  /** 写能力探测：老远端抛 Method not found 判为不支持；版本不匹配（新服务端）判为支持。 */
  window.__probeWrite = async (mode) => {
    const fileService =
      mode === "old-remote"
        ? { writeBinaryFile: async () => { throw new Error("Method not found: fileService.writeBinaryFile"); } }
        : mode === "new-remote"
          ? { writeBinaryFile: async () => { throw new Error("File revision mismatch: /x (disk 10B/1 vs expected -1B/-1)"); } }
          : { writeBinaryFile: async () => ({ path: "/x", bytes: 0, revision: { size: 0, mtimeMs: 0 } }) };
    return await probeWriteSupport(fileService, "/x");
  };

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
      `export { probeWriteSupport } from ${JSON.stringify(join(editorDir, "fileWriteSupport.ts"))};`,
      `export { preserveHeaderFooter } from ${JSON.stringify(join(editorDir, "docxHeaderFooter.ts"))};`,
      `export { applyTrackedChanges, acceptedText, rejectedText } from ${JSON.stringify(join(editorDir, "docxTrackChanges.ts"))};`,
      `export { applyRevisionView, restoreRevisions, buildRevisionView, listRevisions, resolveRevisions } from ${JSON.stringify(join(editorDir, "docxRevisions.ts"))};`,
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
