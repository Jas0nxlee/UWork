/**
 * **插入表格**（`p:graphicFrame` + `a:tbl`）。
 *
 * 与插入图片不同，表格**不需要新增部件**（没有图片那种 `ppt/media/*` 与 rels 手术），
 * 所以走的是普通的"改这一页 XML"通道（`patchSlideXml`）——保存时仍然只写回改过的那几页。
 *
 * 几个容易写错的地方（都按 OOXML 来）：
 *   - 表格是 `p:graphicFrame`，几何在 **`p:xfrm`**（不是 `p:spPr/a:xfrm`）；`setShapeBounds` 里
 *     `getElementsByTagNameNS(A_NS,"xfrm")` 会先找到它 ✓ 所以插入后照样能拖动缩放。
 *   - `a:graphicData` 的 `uri` 必须是 table 的那个命名空间；`a:tbl` 里 `a:tblGrid` 的 `a:gridCol@w`
 *     与每行 `a:tr@h` 都是 EMU。
 *   - 每个单元格要给 **空 `a:txBody`**：这样"表格还是可编辑的"——右侧「文本」里一格一条，
 *     用户马上就能填字（也让 `readSlideText` 认得出这些格子）。
 */
import { A_NS, P_NS, writeBack } from "./pptShapes.js";

const TABLE_URI = "http://schemas.openxmlformats.org/drawingml/2006/table";

const MAX_ROWS = 20;
const MAX_COLS = 12;

export interface InsertTableInput {
  rows: number;
  cols: number;
  /** 页面尺寸（EMU）：不传就按内容自适应宽高各占一半居中。 */
  pageWidth: number;
  pageHeight: number;
  /** 形状名（不传就按"表格 N"）。 */
  name?: string;
}

export interface InsertTableResult {
  xml: string;
  name: string;
  bounds: { x: number; y: number; width: number; height: number };
}

export function insertTable(xml: string, input: InsertTableInput): InsertTableResult {
  const rows = Math.max(1, Math.min(MAX_ROWS, Math.round(input.rows)));
  const cols = Math.max(1, Math.min(MAX_COLS, Math.round(input.cols)));
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const tree = document.getElementsByTagNameNS(P_NS, "spTree")[0];
  if (!tree) throw new Error("这一页没有 spTree，插不了表格");

  const existingIds = Array.from(tree.getElementsByTagNameNS(P_NS, "cNvPr")).map((node) =>
    Number(node.getAttribute("id") ?? 0),
  );
  const shapeId = (existingIds.length > 0 ? Math.max(...existingIds) : 1) + 1;
  const name = input.name ?? `表格 ${shapeId}`;

  // 尺寸：宽占页面 60%，每行约 0.9 厘米，整体居中
  const width = Math.round(input.pageWidth * 0.6);
  const rowHeight = 320000;
  const height = rowHeight * rows;
  const bounds = {
    x: Math.round((input.pageWidth - width) / 2),
    y: Math.round((input.pageHeight - height) / 2),
    width,
    height,
  };
  const columnWidth = Math.round(width / cols);

  const frame = document.createElementNS(P_NS, "p:graphicFrame");
  const table = document.createElementNS(A_NS, "a:tbl");
  const properties = document.createElementNS(A_NS, "a:tblPr");
  properties.setAttribute("firstRow", "1");
  properties.setAttribute("bandRow", "1");
  const grid = document.createElementNS(A_NS, "a:tblGrid");
  for (let col = 0; col < cols; col += 1) {
    const gridCol = document.createElementNS(A_NS, "a:gridCol");
    gridCol.setAttribute("w", String(columnWidth));
    grid.append(gridCol);
  }
  table.append(properties, grid);
  for (let row = 0; row < rows; row += 1) {
    const tr = document.createElementNS(A_NS, "a:tr");
    tr.setAttribute("h", String(rowHeight));
    for (let col = 0; col < cols; col += 1) {
      const tc = document.createElementNS(A_NS, "a:tc");
      const body = document.createElementNS(A_NS, "a:txBody");
      body.append(
        document.createElementNS(A_NS, "a:bodyPr"),
        document.createElementNS(A_NS, "a:lstStyle"),
        document.createElementNS(A_NS, "a:p"),
      );
      tc.append(body, document.createElementNS(A_NS, "a:tcPr"));
      tr.append(tc);
    }
    table.append(tr);
  }
  const graphicData = document.createElementNS(A_NS, "a:graphicData");
  graphicData.setAttribute("uri", TABLE_URI);
  graphicData.append(table);
  const graphic = document.createElementNS(A_NS, "a:graphic");
  graphic.append(graphicData);

  // p:graphicFrame 的子元素顺序固定：nvGraphicFramePr → xfrm → graphic
  frame.innerHTML = [
    `<p:nvGraphicFramePr xmlns:p="${P_NS}">`,
    `<p:cNvPr id="${shapeId}" name="${name.replace(/"/g, "")}"/>`,
    `<p:cNvGraphicFramePr/>`,
    `<p:nvPr/>`,
    `</p:nvGraphicFramePr>`,
  ].join("");
  const transform = document.createElementNS(P_NS, "p:xfrm");
  const offset = document.createElementNS(A_NS, "a:off");
  offset.setAttribute("x", String(bounds.x));
  offset.setAttribute("y", String(bounds.y));
  const extent = document.createElementNS(A_NS, "a:ext");
  extent.setAttribute("cx", String(bounds.width));
  extent.setAttribute("cy", String(bounds.height));
  transform.append(offset, extent);
  frame.append(transform, graphic);
  tree.append(frame);

  return { xml: writeBack(document), name, bounds };
}
