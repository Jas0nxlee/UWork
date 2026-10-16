/**
 * xlsx 的**导入前护栏**（与 docx 的 docxPreflight 同职责，见 specs/office-editors-triad.md）。
 *
 * 为什么 xlsx 也要护栏：我们打算用 SheetJS 读+写 xlsx，而**重写会丢掉它不认识的东西**——
 * 图表、透视表、条件格式、数据验证、图片、宏、外部连接、切片器。用户"打开一个带图表的报表、改个数字、
 * 保存"就会把图表弄没，这跟当初 docx 里"修订被静默丢掉"是同一类事故。所以：
 *   命中这些特性 → **不给编辑**（只读预览 + 明确说明），而不是改完再发现少了东西。
 * 结构简单的工作簿（值 + 公式 + 常用格式）→ 可以编辑，并走与 docx 同款的产物校验。
 *
 * 实现方式：直接看 zip 里的部件名（不解压内容），比解析整棵树快且够用：
 *   - `xl/charts/*`、`xl/drawings/*`、`xl/media/*` → 图表/图片/形状
 *   - `xl/pivotTables/*`、`xl/pivotCache/*` → 透视表
 *   - `xl/vbaProject.bin` → 宏
 *   - `xl/connections.xml`、`xl/queryTables/*` → 外部连接
 *   - `xl/tables/*`（结构化表格）、`xl/comments*.xml`（批注）、`xl/slicers/*` → 一并列入"会丢"
 * 另外看 `sheetN.xml` 里有没有条件格式（`<conditionalFormatting`）与数据验证（`<dataValidation`）。
 */
import JSZip from "jszip";

export interface XlsxFindings {
  charts: number;
  images: number;
  pivotTables: number;
  vba: boolean;
  externalConnections: number;
  structuredTables: number;
  slicers: number;
  comments: number;
  conditionalFormats: number;
  dataValidations: number;
  /** 工作表数（用于 UI 与体积判断）。 */
  sheets: number;
  /** 解压后所有部件的总字节数（xlsx 的体积口径与 docx 同理，文件会小十几倍）。 */
  uncompressedBytes: number;
}

export function emptyXlsxFindings(): XlsxFindings {
  return {
    charts: 0,
    images: 0,
    pivotTables: 0,
    vba: false,
    externalConnections: 0,
    structuredTables: 0,
    slicers: 0,
    comments: 0,
    conditionalFormats: 0,
    dataValidations: 0,
    sheets: 0,
    uncompressedBytes: 0,
  };
}

interface ZipLike {
  files: Record<
    string,
    { dir: boolean; async: (type: "string" | "uint8array") => Promise<unknown> }
  >;
}

function countMatch(names: string[], pattern: RegExp): number {
  return names.filter((name) => pattern.test(name)).length;
}

/** 分析一份 xlsx（只看部件名 + 少量 XML 计数，不解压全部内容）。 */
export async function analyzeXlsx(bytes: ArrayBuffer): Promise<XlsxFindings> {
  const findings = emptyXlsxFindings();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return findings;
  }
  const names = Object.keys((zip as unknown as ZipLike).files);
  findings.charts = countMatch(names, /^xl\/charts\//);
  findings.images = countMatch(names, /^xl\/media\//);
  findings.pivotTables = countMatch(names, /^xl\/(?:pivotTables|pivotCache)\//);
  findings.vba = names.some((name) => /vbaProject\.bin$/i.test(name));
  findings.externalConnections =
    countMatch(names, /^xl\/connections\.xml$/) + countMatch(names, /^xl\/queryTables\//);
  findings.structuredTables = countMatch(names, /^xl\/tables\//);
  findings.slicers = countMatch(names, /^xl\/slicers\//);
  findings.comments = countMatch(names, /^xl\/comments\d*\.xml$/);
  findings.sheets = countMatch(names, /^xl\/worksheets\/sheet\d+\.xml$/);

  for (const name of names.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry))) {
    const entry = (zip as unknown as ZipLike).files[name];
    const xml = entry ? ((await entry.async("string")) as string) : "";
    findings.conditionalFormats += (xml.match(/<conditionalFormatting[ >]/g) ?? []).length;
    findings.dataValidations += (xml.match(/<dataValidation[ >]/g) ?? []).length;
  }
  // 体积口径：所有部件解压后的总字节（xlsx 的 document 会膨胀十几倍，按文件大小限流不靠谱）
  let total = 0;
  for (const [name, entry] of Object.entries((zip as unknown as ZipLike).files)) {
    if (entry.dir) continue;
    const content = (await entry.async("uint8array")) as Uint8Array;
    total += content.byteLength;
    void name;
  }
  findings.uncompressedBytes = total;
  return findings;
}

/**
 * 能不能进应用内编辑 + 为什么（用户看得到的那句话）。
 * 与 docx 的护栏同口径：**只有真的会丢内容/结构的才拦**，其余（例如纯值+公式的工作簿）直接放行。
 */
export function summarizeXlsxFindings(findings: XlsxFindings): string[] {
  const lines: string[] = [];
  const lossy: string[] = [];
  if (findings.charts) lossy.push(`图表 ${findings.charts} 个`);
  if (findings.pivotTables) lossy.push(`透视表 ${findings.pivotTables} 个`);
  if (findings.vba) lossy.push("宏（vbaProject.bin）");
  if (findings.externalConnections) lossy.push(`外部连接 ${findings.externalConnections} 处`);
  if (findings.structuredTables) lossy.push(`结构化表格 ${findings.structuredTables} 个`);
  if (findings.images) lossy.push(`图片/形状 ${findings.images} 个`);
  if (findings.slicers) lossy.push(`切片器 ${findings.slicers} 个`);
  if (lossy.length > 0) lossy.push("条件格式/数据验证");
  if (findings.charts || findings.pivotTables || findings.vba || findings.externalConnections) {
    lines.push(
      `${lossy.join("、")}：应用内编辑（SheetJS 重写）会丢掉这些，因此**这份工作簿只提供只读预览**`,
    );
  }
  if (findings.comments) lines.push(`批注 ${findings.comments} 处（会丢，因此一并按只读处理）`);
  return lines;
}
