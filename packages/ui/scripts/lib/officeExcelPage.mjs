/**
 * Excel 编辑位的**页面脚手架**：esbuild 现场打 React 入口 + fortune-sheet 工作簿挂载点。
 *
 * 与 Word 那边（officeBehaviorPage）的分工一致：这里只负责"把引擎装进浏览器"，
 * 断言写在 check-office-excel.mjs / check-office-excel-io.mjs 里。入口 import 的是**仓库里的真模块**
 * （适配层/校验/护栏），所以回归跑的是产品代码，不是另写一份。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXCEL_PAGE = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/excel.css">
<style>html,body{margin:0;height:100%}#host{height:100%}</style>
<div id="host"></div>
<script type="module" src="/excel.js"></script>`;

const ENTRY_HEAD = `
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Workbook } from "@fortune-sheet/react";
import "@fortune-sheet/react/dist/index.css";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import * as app from "./app.js";

window.ExcelJS = ExcelJS;
window.JSZip = JSZip;
window.app = app;
`;

/** 最小 React 宿主：产品里这层是 ExcelEditorSurface.tsx，检查只需要能驱动引擎。 */
const ENTRY_COMPONENT = `
const apiRef = { current: null };
const host = document.getElementById("host");
let root = null;
let flowRoot = null;

function Harness({ data, allowEdit, showToolbar }) {
  // 非受控：数据只在挂载时给一次，之后的改动由引擎自己维护（产品里也一样：
  // 保存时用 getAllSheets() 取当前状态，而不是把每次 onChange 回灌进组件——那会打断输入法/选区）。
  const [initial] = useState(data);
  return createElement(Workbook, {
    ref: apiRef,
    data: initial,
    allowEdit,
    showToolbar,
    showFormulaBar: true,
    showSheetTabs: true,
    lang: "zh",
    onChange: () => {
      window.__changeCount += 1;
    },
    onOp: (ops) => {
      window.__opCount += ops.length;
    },
  });
}

window.__excel = {
  /** 挂载一个工作簿：data 为 fortune-sheet 的 Sheet[]。 */
  async mount(options = {}) {
    window.__changeCount = 0;
    window.__opCount = 0;
    window.__structureEdits = [];
    root?.unmount();
    // 必须换一个干净的容器：引擎把画布画在容器里，React 卸载**不会**清掉它自己的 DOM，
    // 留着旧画布的话，后面用鼠标点的其实是上一个实例的残骸（断言会变成"点了没反应"的假通过）
    host.replaceChildren();
    const container = document.createElement("div");
    container.style.height = "100%";
    host.append(container);
    root = createRoot(container);
    root.render(
      createElement(Harness, {
        data: options.data ?? window.app.sampleSheets(),
        allowEdit: options.allowEdit !== false,
        showToolbar: options.showToolbar === true,
      }),
    );
    // React 19 的 root.render 是并发调度，等两帧再让断言去读 DOM/canvas
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  },
  api: () => apiRef,
  counts: () => ({ changes: window.__changeCount, ops: window.__opCount }),
  structureEdits: () => window.__structureEdits ?? [],
  /** 单元格当前值（引擎侧真相，不经过 DOM）。 */
  cell: (row, column, type) =>
    apiRef.current?.getCellValue(row, column, type ? { type } : undefined),
  sheets: () => apiRef.current?.getAllSheets(),
  /** 设选区（行列都是零基、含端点），用于驱动功能区命令。 */
  select: async (range) => {
    apiRef.current?.setSelection([range]);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  },
  /** 走**我们自己的**命令调度（excelCommands.ts），把状态栏消息带回来。 */
  async run(command, args) {
    const messages = [];
    const handled = window.app.runExcelCommand(
      {
        api: () => apiRef.current,
        setStatus: (message) => messages.push(message),
        getSheets: () => apiRef.current?.getAllSheets() ?? [],
        recordStructureEdit: (edit, sheetName) => {
          window.__structureEdits = window.__structureEdits ?? [];
          window.__structureEdits.push({ sheetName, edit });
          // 同时也报给**编辑位自己的钩子**（保存时要在文件上做同样的搬移）——
          // 检查里这样才走的是产品那条接线，而不是另开一条
          window.__flowRecordStructureEdit?.(edit, sheetName);
        },
      },
      command,
      args ?? [],
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { handled, messages };
  },
  /** exceljs 能不能在浏览器里跑（读 + 写 + 公式）——Excel 编辑位的 I/O 全靠它。 */
  excelRoundTrip: async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S1");
    ws.getCell("A1").value = "hello";
    ws.getCell("B1").value = 2;
    ws.getCell("C1").value = { formula: "B1*2", result: 4 };
    const buffer = await wb.xlsx.writeBuffer();
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buffer);
    const ws2 = wb2.getWorksheet("S1");
    return {
      bytes: buffer.byteLength,
      a1: ws2.getCell("A1").value,
      b1: ws2.getCell("B1").value,
      c1Formula: ws2.getCell("C1").value?.formula,
    };
  },
};
`;

/**
 * xlsx 适配层的检查入口（check-office-excel-io.mjs 用）。
 *
 * fixture 是**现场用 exceljs 造**的：值/公式/格式/合并/列宽行高/批注/超链接/数据验证/冻结/隐藏表
 * 都放进去，这样"差分写回到底保住了什么"可以用同一份样本量到底，不依赖仓库里躺的二进制样本。
 */
const ENTRY_XLSX = `
window.__xlsx = {
  async fixture(options = {}) {
    const wb = new ExcelJS.Workbook();
    const data = wb.addWorksheet("数据");
    data.getCell("A1").value = "名称";
    data.getCell("A1").font = { bold: true, size: 12, color: { argb: "ffd93025" } };
    data.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "fffff2cc" } };
    data.getCell("B1").value = "数量";
    data.getCell("A2").value = "苹果";
    data.getCell("A2").note = "这里是批注";
    data.getCell("B2").value = 3;
    data.getCell("B2").dataValidation = { type: "list", allowBlank: true, formulae: ['"1,2,3"'] };
    data.getCell("A3").value = { text: "苹果官网", hyperlink: "https://example.com/apple" };
    data.getCell("B3").value = 4.5678;
    data.getCell("B3").numFmt = "0.00";
    data.getCell("B4").value = { formula: "SUM(B2:B3)", result: 7.5678 };
    data.getCell("A5").value = "合并单元格";
    data.mergeCells("A5:B5");
    data.getColumn(1).width = 20;
    data.getRow(2).height = 30;
    data.views = [{ state: "frozen", xSplit: 1, ySplit: 1, showGridLines: true }];
    const notes = wb.addWorksheet("说明");
    notes.getCell("A1").value = "第二张表";
    notes.getCell("A2").value = 42;
    const hidden = wb.addWorksheet("隐藏表");
    hidden.state = "hidden";
    hidden.getCell("A1").value = "不该被看见";
    const bytes = await wb.xlsx.writeBuffer();
    if (!options.chart) return { bytes };
    // 护栏用例：exceljs 不会写图表，所以直接往 zip 里塞一个图表部件 + 指向它的关系
    const zip = await JSZip.loadAsync(bytes);
    zip.file("xl/charts/chart1.xml", "<c:chartSpace/>");
    return { bytes: await zip.generateAsync({ type: "arraybuffer" }) };
  },
  read: (bytes) => window.app.readXlsxToSheets(bytes),
  write: (input) => window.app.writeSheetsToXlsx(input),
  validate: (candidate, source) => window.app.validateXlsxCandidate(candidate, source),
  analyze: (bytes) => window.app.analyzeXlsx(bytes),
  summarize: (findings) => window.app.summarizeXlsxFindings(findings),
  /** 一份 xlsx 里有哪些部件（用来证明"没动的部件原样还在"）。 */
  async parts(bytes) {
    const zip = await JSZip.loadAsync(bytes);
    const out = {};
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      out[name] = (await entry.async("uint8array")).byteLength;
    }
    return out;
  },
  /** 直接用 exceljs 读回产物做独立验证（不经过我们的读路径，避免自证）。 */
  async inspect(bytes, sheetName = "数据") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes);
    const sheet = wb.getWorksheet(sheetName);
    const notes = wb.getWorksheet("说明");
    return {
      sheetNames: wb.worksheets.map((worksheet) => worksheet.name),
      hidden: wb.getWorksheet("隐藏表")?.state,
      a2: sheet?.getCell("A2").value,
      a1Font: sheet?.getCell("A1").font,
      a1Fill: sheet?.getCell("A1").fill,
      a2note: sheet?.getCell("A2").note && String(sheet.getCell("A2").note),
      b3: sheet?.getCell("B3").value,
      b3numFmt: sheet?.getCell("B3").numFmt,
      b4: sheet?.getCell("B4").value,
      a3: sheet?.getCell("A3").value,
      merged: sheet?.model.merges,
      columnWidth: sheet?.getColumn(1).width,
      rowHeight: sheet?.getRow(2).height,
      frozen: sheet?.views?.[0]?.state,
      validations: Object.keys(sheet?.dataValidations?.model ?? {}).length,
      notesA2: notes?.getCell("A2").value,
    };
  },
};


/**
 * 产品**生命周期钩子**的检查入口（check-office-excel-flow.mjs 用）：
 * 把 useExcelDocument 真挂进一个 React 组件里跑，配一个假的 IFileService，
 * 于是"读文件 → 护栏 → 改 → 差分写回 → 产物校验 → 调 writeBinaryFile"这条真路径全在回归范围内。
 */
window.__flow = {
  async start(options = {}) {
    window.__flowCalls = [];
    window.__flowDirty = null;
    // 必须清掉上一次的状态：否则下面的等待循环会读到**上一个实例**的 ready=true 直接返回
    window.__flowState = null;
    window.__flowSheets = options.sheets ?? null;
    const service = {
      readBinaryPreview: async () => ({
        path: "/tmp/表.xlsx",
        dataBase64: options.base64,
        totalBytes: options.totalBytes ?? 4096,
      }),
      stat: async () => ({ mtimeMs: 1700000000000 }),
      writeBinaryFile: async (args) => {
        window.__flowCalls.push(args);
        if (options.failWrite) throw new Error("File revision mismatch: expected 1 got 2");
        return { revision: { size: 11, mtimeMs: 12 }, backup: "/tmp/表.xlsx.bak", bytes: 123 };
      },
    };
    // 用自己的容器（挂在 body 上、不参与布局）：它要和 #host 里的引擎**同时存在**，
    // 这样"引擎里的真实数据 → 保存"这条路才验得到（抢同一个 host 会把引擎卸载掉）
    flowRoot?.unmount();
    const container = document.createElement("div");
    container.style.display = "none";
    document.body.append(container);
    flowRoot = createRoot(container);
    flowRoot.render(createElement(FlowHost, { service }));
    // 载入是异步的（要解压 + exceljs 解析 + 护栏）：等到"就绪"或者明确失败/拒绝为止，
    // 固定 sleep 会让断言读到"正在打开…"这种中间态
    const deadline = Date.now() + (options.waitMs ?? 20000);
    while (Date.now() < deadline) {
      const state = window.__flowState;
      if (state?.ready === true) break;
      if (state && /失败|过大|不支持|只读/.test(state.status) && !state.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // 再等一帧：React 的状态提交是异步的，状态栏文案（"已保存/没有检测到改动"）常在这一帧才到
    await new Promise((resolve) => setTimeout(resolve, 80));
    return window.__flow.state();
  },
  state: () => {
    const state = window.__flowState;
    if (!state) return null;
    return {
      status: state.status,
      ready: state.ready,
      dirty: state.dirty,
      busy: state.busy,
      writeBlocked: state.writeBlocked,
      readOnly: state.guard?.readOnly ?? null,
      notices: state.guard?.notices ?? [],
      sheetNames: state.sheets?.map((sheet) => sheet.name) ?? null,
    };
  },
  setSheets: (sheets) => {
    window.__flowSheets = sheets;
  },
  sheets: () => window.__flowSheets,
  async save() {
    await window.__flowState.save();
    // 同上：save 里的 setStatus 要等 React 提交后才是新的
    await new Promise((resolve) => setTimeout(resolve, 80));
  },
  calls: () => window.__flowCalls,
  dirty: () => window.__flowDirty,
  base64: (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(offset, offset + 0x8000)));
    }
    return btoa(binary);
  },
};

function FlowHost({ service }) {
  const state = window.app.useExcelDocument({
    fileService: service,
    path: "/tmp/表.xlsx",
    // 优先拿**引擎里的真实数据**（getAllSheets 给的是 data 矩阵、没有 celldata，
    // 与导入快照形状不同——保存路径必须同时认这两种，这里就是盯着它的）
    getSheets: () => window.__excel?.api?.()?.current?.getAllSheets() ?? window.__flowSheets ?? undefined,
    onDirtyChange: (dirty) => {
      window.__flowDirty = dirty;
    },
  });
  window.__flowState = state;
  window.__flowRecordStructureEdit = state.recordStructureEdit;
  return null;
}

/** 一份 xlsx 里还有哪些公式（诊断用：结构编辑会把公式整行搬走）。 */
window.__formulaReport = async (bytes) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const out = [];
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value;
        if (value && typeof value === "object" && "formula" in value) {
          out.push(worksheet.name + "!" + cell.address + "=" + value.formula);
        }
      });
    });
  }
  return out;
};

window.__ready = true;
`;

const ENTRY = ENTRY_HEAD + ENTRY_COMPONENT + ENTRY_XLSX;

/**
 * 写入口 + 打产物（CSS 也要单独落盘：页面用 <link> 引）。
 * `modules` 是要暴露给断言的**仓库模块**（形如 `["xlsxWorkbook.ts", "xlsxValidate.ts"]`），
 * 逐个 `export *` 聚到一个 app.js 里。
 */
export async function bundleExcelEntry(dir, options) {
  const entry = join(dir, "entry.tsx");
  const appEntry = join(dir, "app.ts");
  writeFileSync(
    appEntry,
    [
      ...options.modules.map(
        (name) => `export * from ${JSON.stringify(join(options.editorDir, name))};`,
      ),
      `export const sampleSheets = () => (${JSON.stringify(options.sampleSheets, null, 1)});`,
    ].join("\n"),
    "utf8",
  );
  writeFileSync(entry, ENTRY, "utf8");
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    entryPoints: { excel: entry },
    outdir: dir,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    absWorkingDir: options.repoRoot,
    // 入口写在临时目录里，裸包名靠 nodePaths 才能找到仓库的 node_modules
    nodePaths: [join(options.repoRoot, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    // fortune-sheet 的样式由它自己的包内 CSS 带进来；两边都要落盘
    loader: { ".css": "css", ".ttf": "dataurl", ".woff": "dataurl", ".woff2": "dataurl" },
  });
  for (const file of result.outputFiles) {
    const name = file.path.endsWith(".css") ? "excel.css" : "excel.js";
    writeFileSync(join(dir, name), file.text, "utf8");
  }
}
