/**
 * 表格的**单元格级读写**：定位某个单元格的 `txBody`、改它的文字、增删行列。
 *
 * 为什么按"txBody 的全局序号"落笔：改文字那条路（`patchTxBody` → 段落改写、沿用首段样式）
 * 已经被回归盯住了，表格单元格的 `a:txBody` 也在同一串里——所以只要算出目标单元格的
 * **全局序号**，就能复用同一条写入路径，不用另写一套段落逻辑。
 *
 * 行列坐标口径：与渲染器给的一致（`rowIndex` / `cellIndex`，0 基、**不含**合并单元格的换算）。
 */
import { A_NS, P_NS, shapeByName, writeBack } from "./pptShapes.js";

function parser(): DOMParser {
  return new DOMParser();
}

/** 表格里所有单元格（按文档序：行优先）。 */
function cellsOf(table: Element): Element[][] {
  return Array.from(table.getElementsByTagNameNS(A_NS, "tr")).map((row) =>
    Array.from(row.children).filter((child) => child.localName === "tc"),
  );
}

/**
 * 某个单元格的 `txBody` 在**整页**里的序号（`patchTxBody` 用的就是它）。
 * 找不到（表格名对不上 / 行列越界 / 这格没有 txBody）返回 null。
 */
export function cellBlockIndexOf(
  xml: string,
  tableName: string,
  rowIndex: number,
  cellIndex: number,
): number | null {
  const document = parser().parseFromString(xml, "application/xml");
  const frame = shapeByName(document, tableName);
  if (!frame) return null;
  const rows = cellsOf(frame);
  const cell = rows[rowIndex]?.[cellIndex];
  if (!cell) return null;
  const target = cell.getElementsByTagNameNS(A_NS, "txBody")[0];
  if (!target) return null;
  const all = Array.from(document.getElementsByTagNameNS("*", "txBody"));
  const index = all.indexOf(target);
  return index < 0 ? null : index;
}

/** 这个形状是不是表格（`p:graphicFrame` 且内含 `a:tbl`）。 */
export function isTableShape(xml: string, shapeName: string): boolean {
  const document = parser().parseFromString(xml, "application/xml");
  const frame = shapeByName(document, shapeName);
  if (!frame || frame.localName !== "graphicFrame") return false;
  return Boolean(frame.getElementsByTagNameNS(A_NS, "tbl")[0]);
}

const ROW_HEIGHT = 320000;
const MIN_ROWS = 1;
const MIN_COLS = 1;

export type TableStructureOp =
  | { kind: "insertRowAbove" }
  | { kind: "insertRowBelow" }
  | { kind: "insertColumnLeft" }
  | { kind: "insertColumnRight" }
  | { kind: "deleteRow" }
  | { kind: "deleteColumn" };

/**
 * 表格结构操作（在光标所在单元格处增删行列）。
 *
 * `p:xfrm` 的 `a:ext` 要跟着改：加一行高度就加一行高、加一列宽度就加一列宽——否则表格内容
 * 会挤在原来的框里、跟画的格子对不上。删到只剩一行/一列就不让删（PowerPoint 同款：表格至少 1×1）。
 */
export function applyTableStructureEdit(
  xml: string,
  tableName: string,
  rowIndex: number,
  cellIndex: number,
  op: TableStructureOp,
): string {
  const document = parser().parseFromString(xml, "application/xml");
  const frame = shapeByName(document, tableName);
  if (!frame) return xml;
  const table = frame.getElementsByTagNameNS(A_NS, "tbl")[0];
  const grid = table?.getElementsByTagNameNS(A_NS, "tblGrid")[0];
  if (!table || !grid) return xml;
  const rows = cellsOf(table);
  const columnCount = grid.getElementsByTagNameNS(A_NS, "gridCol").length;
  const rowCount = rows.length;
  if (rowCount === 0 || columnCount === 0) return xml;

  const emptyCell = () => {
    const cell = document.createElementNS(A_NS, "a:tc");
    const body = document.createElementNS(A_NS, "a:txBody");
    body.append(
      document.createElementNS(A_NS, "a:bodyPr"),
      document.createElementNS(A_NS, "a:lstStyle"),
      document.createElementNS(A_NS, "a:p"),
    );
    cell.append(body, document.createElementNS(A_NS, "a:tcPr"));
    return cell;
  };
  /** 几何跟着走：改 p:xfrm（graphicFrame 的几何在 PresentationML 的 p:xfrm 上）。 */
  const growBounds = (deltaX: number, deltaY: number) => {
    const extent = frame.getElementsByTagNameNS(A_NS, "ext")[0];
    if (!extent) return;
    const cx = Number(extent.getAttribute("cx") ?? 0) + deltaX;
    const cy = Number(extent.getAttribute("cy") ?? 0) + deltaY;
    extent.setAttribute("cx", String(Math.max(1, cx)));
    extent.setAttribute("cy", String(Math.max(1, cy)));
  };

  if (op.kind === "insertRowAbove" || op.kind === "insertRowBelow") {
    const at = op.kind === "insertRowAbove" ? rowIndex : rowIndex + 1;
    const row = document.createElementNS(A_NS, "a:tr");
    const trs = table.getElementsByTagNameNS(A_NS, "tr");
    const height = trs[Math.min(rowIndex, rowCount - 1)]?.getAttribute("h") ?? String(ROW_HEIGHT);
    row.setAttribute("h", height);
    for (let col = 0; col < columnCount; col += 1) row.append(emptyCell());
    const reference = table.getElementsByTagNameNS(A_NS, "tr")[at] ?? null;
    table.insertBefore(row, reference);
    growBounds(0, Number(height));
  }

  if (op.kind === "insertColumnLeft" || op.kind === "insertColumnRight") {
    const at = op.kind === "insertColumnLeft" ? cellIndex : cellIndex + 1;
    const columns = grid.getElementsByTagNameNS(A_NS, "gridCol");
    const width = Number(columns[Math.min(cellIndex, columnCount - 1)]?.getAttribute("w") ?? 0);
    const gridCol = document.createElementNS(A_NS, "a:gridCol");
    gridCol.setAttribute("w", String(width));
    grid.insertBefore(gridCol, columns[at] ?? null);
    for (const row of Array.from(table.getElementsByTagNameNS(A_NS, "tr"))) {
      const cells = Array.from(row.children).filter((child) => child.localName === "tc");
      row.insertBefore(emptyCell(), cells[at] ?? null);
    }
    growBounds(width, 0);
  }

  if (op.kind === "deleteRow" && rowCount > MIN_ROWS) {
    const row = table.getElementsByTagNameNS(A_NS, "tr")[rowIndex];
    if (row) {
      growBounds(0, -Number(row.getAttribute("h") ?? 0));
      row.remove();
    }
  }

  if (op.kind === "deleteColumn" && columnCount > MIN_COLS) {
    const columns = grid.getElementsByTagNameNS(A_NS, "gridCol");
    const column = columns[cellIndex];
    if (column) {
      growBounds(-Number(column.getAttribute("w") ?? 0), 0);
      column.remove();
      for (const row of Array.from(table.getElementsByTagNameNS(A_NS, "tr"))) {
        const cells = Array.from(row.children).filter((child) => child.localName === "tc");
        cells[cellIndex]?.remove();
      }
    }
  }

  return writeBack(document);
}

/** 表格的行列数（界面显示"3×4"用）。 */
export function tableSizeOf(xml: string, tableName: string): { rows: number; cols: number } | null {
  const document = parser().parseFromString(xml, "application/xml");
  const frame = shapeByName(document, tableName);
  const table = frame?.getElementsByTagNameNS(A_NS, "tbl")[0];
  if (!table) return null;
  const grid = table.getElementsByTagNameNS(A_NS, "tblGrid")[0];
  return {
    rows: table.getElementsByTagNameNS(A_NS, "tr").length,
    cols: grid ? grid.getElementsByTagNameNS(A_NS, "gridCol").length : 0,
  };
}

export { P_NS };

/** 表格里的某个单元格元素（`a:tr[row]/a:tc[col]`）。 */
function cellElement(
  document: Document,
  tableName: string,
  row: number,
  col: number,
): Element | null {
  const frame = shapeByName(document, tableName);
  if (!frame) return null;
  return cellsOf(frame)[row]?.[col] ?? null;
}

/** 单元格的属性容器 `a:tcPr`（没有就补一个，位置按 OOXML 要求放在 txBody 之后）。 */
function ensureCellProperties(document: Document, cell: Element): Element {
  const existing = Array.from(cell.children).find(
    (child) => child.namespaceURI === A_NS && child.localName === "tcPr",
  );
  if (existing) return existing;
  const properties = document.createElementNS(A_NS, "a:tcPr");
  cell.append(properties);
  return properties;
}

export type CellDirection = "right" | "down";

/**
 * **合并单元格**：把光标这一格与它右/下邻的那一格并起来（`gridSpan`/`rowSpan` + 被覆盖格的
 * `hMerge`/`vMerge`，与 PowerPoint 写出来的形态一致）。
 *
 * 界面只提供"向右合并 / 向下合并"，不提供任意矩形合并：我们没有"多选一片单元格"的交互，
 * 与其猜用户的意图，不如给两个明确的方向。
 */
export function mergeCell(
  xml: string,
  tableName: string,
  row: number,
  col: number,
  direction: CellDirection,
): string {
  const document = parser().parseFromString(xml, "application/xml");
  const cell = cellElement(document, tableName, row, col);
  if (!cell) return xml;
  if (direction === "right") {
    const neighbour = cellsOf(shapeByName(document, tableName) as Element)[row]?.[col + 1];
    if (!neighbour) return xml;
    const span =
      (Number(cell.getAttribute("gridSpan") ?? 1) || 1) +
      (Number(neighbour.getAttribute("gridSpan") ?? 1) || 1);
    cell.setAttribute("gridSpan", String(span));
    // 被并掉的那格：内容和标记都清掉，并标成"横向被合并"
    neighbour.removeAttribute("gridSpan");
    neighbour.removeAttribute("rowSpan");
    neighbour.setAttribute("hMerge", "1");
    const body = neighbour.getElementsByTagNameNS(A_NS, "txBody")[0];
    if (body) body.replaceChildren(document.createElementNS(A_NS, "a:p"));
    return writeBack(document);
  }
  const rows = cellsOf(shapeByName(document, tableName) as Element);
  const below = rows[row + 1]?.[col];
  if (!below) return xml;
  const span =
    (Number(cell.getAttribute("rowSpan") ?? 1) || 1) +
    (Number(below.getAttribute("rowSpan") ?? 1) || 1);
  cell.setAttribute("rowSpan", String(span));
  below.removeAttribute("gridSpan");
  below.removeAttribute("rowSpan");
  below.setAttribute("vMerge", "1");
  const body = below.getElementsByTagNameNS(A_NS, "txBody")[0];
  if (body) body.replaceChildren(document.createElementNS(A_NS, "a:p"));
  return writeBack(document);
}

/** **拆分单元格**：把这一格参与过的合并标记全部撤掉（含被它覆盖的那些格）。 */
export function splitCell(xml: string, tableName: string, row: number, col: number): string {
  const document = parser().parseFromString(xml, "application/xml");
  const frame = shapeByName(document, tableName);
  if (!frame) return xml;
  const rows = cellsOf(frame);
  const cell = rows[row]?.[col];
  if (!cell) return xml;
  const gridSpan = Number(cell.getAttribute("gridSpan") ?? 1) || 1;
  const rowSpan = Number(cell.getAttribute("rowSpan") ?? 1) || 1;
  for (let r = row; r < row + rowSpan; r += 1) {
    for (let c = col; c < col + gridSpan; c += 1) {
      const target = rows[r]?.[c];
      if (!target) continue;
      target.removeAttribute("gridSpan");
      target.removeAttribute("rowSpan");
      target.removeAttribute("hMerge");
      target.removeAttribute("vMerge");
    }
  }
  return writeBack(document);
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
  for (const name of ["lnL", "lnR", "lnT", "lnB"]) {
    for (const line of Array.from(properties.getElementsByTagNameNS(A_NS, name))) line.remove();
  }
  if (options.on) {
    for (const name of ["lnL", "lnR", "lnT", "lnB"]) {
      const line = document.createElementNS(A_NS, name);
      line.setAttribute("w", String(options.width ?? 12700));
      line.setAttribute("cap", "flat");
      line.setAttribute("cmpd", "sng");
      line.setAttribute("algn", "ctr");
      const fill = document.createElementNS(A_NS, "a:solidFill");
      const srgb = document.createElementNS(A_NS, "a:srgbClr");
      srgb.setAttribute("val", (options.color ?? "000000").replace(/^#/, "").toUpperCase());
      fill.append(srgb);
      line.append(fill);
      // a:tcPr 的子元素顺序有讲究：四条线要排在 solidFill **之前**
      properties.insertBefore(line, properties.firstChild);
    }
  }
  return writeBack(document);
}

/** **表格样式开关**：首行突出 / 镶边行（`a:tblPr@firstRow|bandRow`，渲染器按它上底色）。 */
export function setTableOptions(
  xml: string,
  tableName: string,
  options: { firstRow?: boolean; bandRow?: boolean },
): string {
  const document = parser().parseFromString(xml, "application/xml");
  const frame = shapeByName(document, tableName);
  const table = frame?.getElementsByTagNameNS(A_NS, "tbl")[0];
  const properties = table?.getElementsByTagNameNS(A_NS, "tblPr")[0];
  if (!properties) return xml;
  if (options.firstRow !== undefined)
    properties.setAttribute("firstRow", options.firstRow ? "1" : "0");
  if (options.bandRow !== undefined)
    properties.setAttribute("bandRow", options.bandRow ? "1" : "0");
  return writeBack(document);
}

/** 表格的样式开关现状（功能区按钮的选中态用它）。 */
export function tableOptionsOf(
  xml: string,
  tableName: string,
): { firstRow: boolean; bandRow: boolean } | null {
  const document = parser().parseFromString(xml, "application/xml");
  const frame = shapeByName(document, tableName);
  const properties = frame
    ?.getElementsByTagNameNS(A_NS, "tbl")[0]
    ?.getElementsByTagNameNS(A_NS, "tblPr")[0];
  if (!properties) return null;
  return {
    firstRow: properties.getAttribute("firstRow") === "1",
    bandRow: properties.getAttribute("bandRow") === "1",
  };
}
