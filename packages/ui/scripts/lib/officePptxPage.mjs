/**
 * PPTX 编辑位的检查脚手架（页面 HTML + esbuild 入口）。
 *
 * 与 Office/Excel 那两套同思路：入口 import **仓库里的真模块**（pptText / pptxValidate /
 * usePptxDocument / PptxEditorPane），断言写在 check-office-pptx.mjs 里。
 * 这里的 fixture 是**现场用 JSZip 造**的一份最小合法 pptx（两张幻灯片 + 一个表格 + 一张图片 +
 * 一条备注 + 母版/版式/主题），这样"只改文字、其余部件逐字节保留"才有东西可验。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const PPTX_PAGE = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%}#host{height:100%}</style>
<div id="host"></div>
<script type="module" src="/pptx.js"></script>`;

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";

const ENTRY_HEAD = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import JSZip from "jszip";
import { parseZip, buildPresentation, materializeAllSlideNodes } from "@aiden0z/pptx-renderer/browser";
import { PptxEditorPane } from "./app.js";
import * as app from "./app.js";

window.JSZip = JSZip;
window.app = app;
const A_NS = ${JSON.stringify(A)};
const P_NS = ${JSON.stringify(P)};
`;

const ENTRY_PPTX = `
/** 造一份最小合法 pptx：两张幻灯片（文本框 + 表格）、一张图片、一条备注、母版/版式/主题。 */
async function fixture() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '</Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '</Relationships>',
  );
  zip.file(
    "ppt/presentation.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:presentation xmlns:p="' + P_NS + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="' + A_NS + '">' +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>' +
      '<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>' +
      '</p:presentation>',
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>' +
      '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
      '</Relationships>',
  );
  // 第 1 页：一个文本框（标题被拆成两个 run、副标题里带段内换行）+ 一个表格
  const slide = (body) =>
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:p="' + P_NS + '" xmlns:a="' + A_NS + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    body +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
  const textBox = (id, name, paragraphs, x, y) =>
    '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + name + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="3000000" cy="1000000"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' + paragraphs + '</p:txBody></p:sp>';
  const para = (text, props) =>
    '<a:p><a:pPr/><a:r><a:rPr lang="zh-CN" sz="2000" b="1"/>' +
    (Array.isArray(text) ? text.map((run) => '<a:t>' + run + '</a:t>').join("") : '<a:t>' + text + '</a:t>') +
    '</a:r>' + (props ?? "") + '</a:p>';
  const table =
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="表格 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="100000" y="3000000"/><a:ext cx="2000000" cy="1000000"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    '<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="2000000"/></a:tblGrid><a:tr h="500000">' +
    '<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>' + para("单元格文字") + '</a:txBody><a:tcPr/></a:tc>' +
    '</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  zip.file(
    "ppt/slides/slide1.xml",
    slide(
      textBox(2, "标题 1", para(["标题", "一"]) + para("副标题", "<a:br/>") ) + table,
    ),
  );
  zip.file(
    "ppt/slides/slide2.xml",
    slide(textBox(3, "标题 2", para("第二页的文字"))),
  );
  // 第 1 页的图片（关系 + 素材）
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>' +
      '</Relationships>',
  );
  zip.file("ppt/media/image1.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  zip.file("ppt/notesSlides/notesSlide1.xml", slide(textBox(4, "备注", para("讲稿备注"))));
  zip.file("ppt/slideMasters/slideMaster1.xml", slide(textBox(5, "母版文字", para("母版"))));
  zip.file("ppt/slideLayouts/slideLayout1.xml", slide(textBox(6, "版式文字", para("版式"))));
  zip.file("ppt/theme/theme1.xml", '<a:theme xmlns:a="' + A_NS + '" name="Office"/>');
  return { bytes: await zip.generateAsync({ type: "arraybuffer" }) };
}

function bodyOf(xml, index) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  // 通配命名空间：形状里是 p:txBody、表格单元格里是 a:txBody（与 pptText.ts 同一口径）
  return Array.from(document.getElementsByTagNameNS("*", "txBody"))[index];
}

window.__pptx = {
  fixture,
  // —— 图片（pptPicture.ts）——
  insertPicture: (input) => window.app.insertPicture(input),
  decodeImageDataUri: (uri) => window.app.decodeImageDataUri(uri),
  imageSizeOf: (bytes) => window.app.imageSizeOf(bytes),
  /** 一张确定性的小 PNG（复用仓库里 Word 检查用的 240×120 样本） */
  async sampleImageDataUri() {
    const response = await fetch("/office-editor-image.png");
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(offset, offset + 0x8000)));
    }
    return 'data:image/png;base64,' + btoa(binary);
  },
  // —— 表格（pptTable.ts）——
  cellBlockIndexOf: (xml, table, row, col) => window.app.cellBlockIndexOf(xml, table, row, col),
  isTableShape: (xml, name) => window.app.isTableShape(xml, name),
  tableSizeOf: (xml, name) => window.app.tableSizeOf(xml, name),
  applyTableStructureEdit: (xml, name, row, col, op) =>
    window.app.applyTableStructureEdit(xml, name, row, col, op),
  // —— 表格插入（pptTableInsert.ts）——
  insertTable: (xml, input) => window.app.insertTable(xml, input),
  // —— 画布几何（pptCanvasGeometry.ts）——
  handleSpots: (box, viewport) => window.app.handleSpots(box, viewport),
  // —— 形状层（pptShapes.ts）——
  readShapes: (xml) => window.app.readSlideShapes(xml),
  setShapeBounds: (xml, name, bounds) => window.app.setShapeBounds(xml, name, bounds),
  setShapeTextFormat: (xml, name, format) => window.app.setShapeTextFormat(xml, name, format),
  setShapeParagraphFormat: (xml, name, format) => window.app.setShapeParagraphFormat(xml, name, format),
  setShapeText: (xml, name, lines) => window.app.setShapeText(xml, name, lines),
  moveShapeZ: (xml, name, direction) => window.app.moveShapeZ(xml, name, direction),
  deleteShape: (xml, name) => window.app.deleteShape(xml, name),
  duplicateShape: (xml, name) => window.app.duplicateShape(xml, name),
  insertTextBox: (xml, options) => window.app.insertTextBox(xml, options),
  // —— 幻灯片层（pptSlides.ts）——
  readSlideOrder: (bytes) => window.app.readSlideOrder(bytes),
  addSlide: (input) => window.app.addSlide(input),
  duplicateSlide: (input) => window.app.duplicateSlide(input),
  deleteSlide: (input) => window.app.deleteSlide(input),
  moveSlide: (input) => window.app.moveSlide(input),
  readDeck: (bytes) => window.app.readDeckSlides(bytes),
  patch: (xml, index, lines) => window.app.patchTxBody(xml, index, lines),
  write: (input) => window.app.writeDeckSlides(input),
  validate: (candidate, source, options) => window.app.validatePptxCandidate(candidate, source, options ?? {}),
  rawZip: (bytes) => JSZip.loadAsync(bytes.slice(0)),
  /** 一份 pptx 里有多少条文本类部件的字节（用来证明"没动的部件没变"）。 */
  async parts(bytes) {
    // JSZip 反复 load 同一份 buffer 会把它消费掉；统一用副本，调用方不用操心
    const zip = await JSZip.loadAsync(bytes.slice(0));
    const out = {};
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const data = await entry.async("uint8array");
      let hash = 0;
      for (const byte of data) hash = (hash * 31 + byte) | 0;
      out[name] = hash;
    }
    return out;
  },
  /** 某个 textBody 的段落（序列化后）与 run 文字，用于验证"加行沿用首段样式"。 */
  paragraphs(xml, index) {
    return Array.from(bodyOf(xml, index)?.children ?? [])
      .filter((child) => child.localName === "p")
      .map((paragraph) => new XMLSerializer().serializeToString(paragraph));
  },
  runTexts(xml, index) {
    const body = bodyOf(xml, index);
    return Array.from(body?.children ?? [])
      .filter((child) => child.localName === "p")
      .map((paragraph) =>
        Array.from(paragraph.getElementsByTagNameNS(A_NS, "t"))
          .map((node) => node.textContent ?? "")
          .join(""),
      );
  },
  /** 用**产品在用的那个渲染器**验证产物确实是一份能打开的 pptx。 */
  async render(bytes) {
    const files = await parseZip(bytes.slice(0));
    const presentation = buildPresentation(files);
    materializeAllSlideNodes(presentation);
    const slides = presentation.slides ?? [];
    const text = slides
      .flatMap((slide) => slide.nodes ?? [])
      .map((node) => (node.textBody?.paragraphs ?? []).flatMap((paragraph) => paragraph.runs.map((run) => run.text)).join(""))
      .join("|");
    return { slides: slides.length, text };
  },
  /** 把编辑位挂起来（界面断言用）。 */
  async mountPane(bytes) {
    window.__pptxService = {
      readBinaryPreview: async () => ({
        path: "/tmp/deck.pptx",
        dataBase64: window.__pptx.base64(bytes),
        totalBytes: bytes.byteLength,
      }),
      stat: async () => ({ mtimeMs: 1700000000000 }),
      writeBinaryFile: async () => ({ revision: { size: 1, mtimeMs: 2 }, bytes: 1 }),
    };
    const host = document.getElementById("host");
    host.replaceChildren();
    const container = document.createElement("div");
    container.style.height = "100%";
    host.append(container);
    const root = createRoot(container);
    root.render(
      createElement(PptxEditorPane, {
        fileService: window.__pptxService,
        path: "/tmp/deck.pptx",
      }),
    );
    return true;
  },
  base64: (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(offset, offset + 0x8000)));
    }
    return btoa(binary);
  },
};

window.__ready = true;
`;

const ENTRY = ENTRY_HEAD + ENTRY_PPTX;

export async function bundlePptxEntry(dir, options) {
  const entry = join(dir, "entry.tsx");
  const appEntry = join(dir, "app.ts");
  writeFileSync(
    appEntry,
    [
      ...options.modules.map(
        (name) => `export * from ${JSON.stringify(join(options.editorDir, name))};`,
      ),
      `export { PptxEditorPane } from ${JSON.stringify(
        join(options.editorDir, "PptxEditorPane.tsx"),
      )};`,
    ].join("\n"),
    "utf8",
  );
  writeFileSync(entry, ENTRY, "utf8");
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    entryPoints: { pptx: entry },
    outdir: dir,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    absWorkingDir: options.repoRoot,
    nodePaths: [join(options.repoRoot, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "css" },
  });
  for (const file of result.outputFiles) {
    const name = file.path.endsWith(".css") ? "pptx.css" : "pptx.js";
    writeFileSync(join(dir, name), file.text, "utf8");
  }
}
