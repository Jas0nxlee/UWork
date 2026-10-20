/**
 * 单元格的**格式**（`a:tcPr` 上的东西 + 格内文字的对齐）：底纹、边框、垂直对齐、水平对齐。
 *
 * 与 `pptTable.ts` 分开的原因：那个文件管**结构**（行列增删、合并拆分），这个只管"这一格长什么样"，
 * 两边都各自守 400 行。
 *
 * 两个对齐的落点不同，是 OOXML 的规定，不是我们的选择：
 *   - **垂直**对齐在 `a:tcPr@anchor`（t / ctr / b）；
 *   - **水平**对齐在**每个段落**的 `a:pPr@algn`（l / ctr / r）——单元格属性上没有水平对齐。
 */
import { A_NS, shapeByName, writeBack } from "./pptShapes.js";
import { cellElement, ensureCellProperties } from "./pptTable.js";

function parser(): DOMParser {
  return new DOMParser();
}

/** **单元格底纹**（`a:tcPr/a:solidFill`）；传 null 表示去掉。 */
export function setCellFill(
  xml: string,
  tableName: string,
  row: number,
  col: number,
  color: string | null,
): string {
  const document = parser().parseFromString(xml, "application/xml");
  const cell = cellElement(document, tableName, row, col);
  if (!cell) return xml;
  const properties = ensureCellProperties(document, cell);
  for (const fill of Array.from(properties.getElementsByTagNameNS(A_NS, "solidFill")))
    fill.remove();
  if (color) {
    const fill = document.createElementNS(A_NS, "a:solidFill");
    const srgb = document.createElementNS(A_NS, "a:srgbClr");
    srgb.setAttribute("val", color.replace(/^#/, "").toUpperCase());
    fill.append(srgb);
    properties.append(fill);
  }
  return writeBack(document);
}

/** **单元格边框**：四边一起给（`a:lnL/lnR/lnT/lnB`）；`on=false` 表示去掉。 */
export function setCellBorder(
  xml: string,
  tableName: string,
  row: number,
  col: number,
  options: { on: boolean; color?: string; width?: number },
): string {
  const document = parser().parseFromString(xml, "application/xml");
  const cell = cellElement(document, tableName, row, col);
  if (!cell) return xml;
  const properties = ensureCellProperties(document, cell);
  for (const side of ["lnL", "lnR", "lnT", "lnB"]) {
    for (const line of Array.from(properties.getElementsByTagNameNS(A_NS, side))) line.remove();
  }
  if (options.on) writeCellLines(document, properties, options);
  return writeBack(document);
}

/** 给一个 `a:tcPr` 加上四边线。顺序有讲究：`lnL/lnR/lnT/lnB` 必须排在 `solidFill` 之类**前面**。 */
function writeCellLines(
  document: Document,
  properties: Element,
  options: { color?: string; width?: number },
): void {
  // 倒序 prepend，落在前面的就是 lnL/lnR/lnT/lnB 这个顺序
  for (const side of ["lnB", "lnT", "lnR", "lnL"]) {
    const line = document.createElementNS(A_NS, side);
    line.setAttribute("w", String(options.width ?? 12700));
    line.setAttribute("cap", "flat");
    line.setAttribute("cmpd", "sng");
    line.setAttribute("algn", "ctr");
    const fill = document.createElementNS(A_NS, "a:solidFill");
    const srgb = document.createElementNS(A_NS, "a:srgbClr");
    srgb.setAttribute("val", (options.color ?? "000000").replace(/^#/, "").toUpperCase());
    fill.append(srgb);
    line.append(fill);
    properties.prepend(line);
  }
}

/**
 * **整张表的网格线**（每格四边都写显式 `a:lnT/B/L/R`）。
 *
 * 为什么不写 `a:tableStyleId`（PowerPoint 插表时的做法）：**渲染器只在 deck 里存在
 * `ppt/tableStyles.xml` 部件时才解析表格样式**（`gf(tableStyleId)` 里第一行就是
 * `if (!tableStyleId || !presentation.tableStyles) return`），我们这份和用户许多文件都没有那个部件
 * → 写了 styleId 也画不出网格（实测：Table Grid / Light Style 1 / Medium Style 2 五个内置 id 全都没线）。
 * 显式的四边线两个地方都认（我们渲染器走 `tcPr/lnX → borderX`，PowerPoint 也认显式线），
 * 所以"要网格"这件事落在显式线上更可靠。
 */
export function setTableGrid(
  xml: string,
  tableName: string,
  on: boolean,
  options?: { color?: string; width?: number },
): string {
  const document = parser().parseFromString(xml, "application/xml");
  const frame = shapeByName(document, tableName);
  if (!frame) return xml;
  const cells = Array.from(frame.getElementsByTagNameNS(A_NS, "tc"));
  for (const cell of cells) {
    const properties = ensureCellProperties(document, cell);
    for (const side of ["lnL", "lnR", "lnT", "lnB"]) {
      for (const line of Array.from(properties.getElementsByTagNameNS(A_NS, side))) line.remove();
    }
    if (on) writeCellLines(document, properties, options ?? {});
  }
  return writeBack(document);
}

/** 整张表有没有网格线（功能区按钮态/排查用）：每格四边都算，缺一条就算没有。 */
export function tableGridOn(xml: string, tableName: string): boolean {
  const document = parser().parseFromString(xml, "application/xml");
  const frame = shapeByName(document, tableName);
  if (!frame) return false;
  const cells = Array.from(frame.getElementsByTagNameNS(A_NS, "tc"));
  return (
    cells.length > 0 &&
    cells.every((cell) =>
      ["lnL", "lnR", "lnT", "lnB"].every(
        (side) => cell.getElementsByTagNameNS(A_NS, side).length > 0,
      ),
    )
  );
}

export type CellAnchor = "top" | "middle" | "bottom";

const ANCHOR_VALUE: Record<CellAnchor, string> = { top: "t", middle: "ctr", bottom: "b" };

/** **垂直对齐**：`a:tcPr@anchor`。 */
export function setCellAnchor(
  xml: string,
  tableName: string,
  row: number,
  col: number,
  anchor: CellAnchor,
): string {
  const document = parser().parseFromString(xml, "application/xml");
  const cell = cellElement(document, tableName, row, col);
  if (!cell) return xml;
  ensureCellProperties(document, cell).setAttribute("anchor", ANCHOR_VALUE[anchor]);
  return writeBack(document);
}

export type CellAlign = "left" | "center" | "right";

const ALIGN_VALUE: Record<CellAlign, string> = { left: "l", center: "ctr", right: "r" };

/** **水平对齐**：写成每个段落的 `a:pPr@algn`（单元格属性上没有水平对齐）。 */
export function setCellAlign(
  xml: string,
  tableName: string,
  row: number,
  col: number,
  align: CellAlign,
): string {
  const document = parser().parseFromString(xml, "application/xml");
  const cell = cellElement(document, tableName, row, col);
  if (!cell) return xml;
  const body = cell.getElementsByTagNameNS(A_NS, "txBody")[0];
  if (!body) return xml;
  for (const paragraph of Array.from(body.children).filter(
    (child) => child.namespaceURI === A_NS && child.localName === "p",
  )) {
    let properties = paragraph.getElementsByTagNameNS(A_NS, "pPr")[0] ?? null;
    if (!properties) {
      properties = document.createElementNS(A_NS, "a:pPr");
      // `a:pPr` 必须是 `a:p` 的**第一个**子元素（OOXML 的 sequence）
      paragraph.prepend(properties);
    }
    properties.setAttribute("algn", ALIGN_VALUE[align]);
  }
  return writeBack(document);
}

/** 这一格现在的对齐（界面判定按钮亮不亮用；没写过返回空）。 */
export function cellFormatOf(
  xml: string,
  tableName: string,
  row: number,
  col: number,
): { anchor: CellAnchor | null; align: CellAlign | null } {
  const document = parser().parseFromString(xml, "application/xml");
  const cell = cellElement(document, tableName, row, col);
  if (!cell) return { anchor: null, align: null };
  const anchorValue = cell
    .getElementsByTagNameNS(A_NS, "tcPr")[0]
    ?.getAttribute("anchor")
    ?.toLowerCase();
  const paragraph = cell
    .getElementsByTagNameNS(A_NS, "txBody")[0]
    ?.getElementsByTagNameNS(A_NS, "p")[0];
  const alignValue = paragraph?.getElementsByTagNameNS(A_NS, "pPr")[0]?.getAttribute("algn") ?? "";
  return {
    anchor:
      (Object.keys(ANCHOR_VALUE) as CellAnchor[]).find(
        (key) => ANCHOR_VALUE[key] === anchorValue,
      ) ?? null,
    align:
      (Object.keys(ALIGN_VALUE) as CellAlign[]).find((key) => ALIGN_VALUE[key] === alignValue) ??
      null,
  };
}
