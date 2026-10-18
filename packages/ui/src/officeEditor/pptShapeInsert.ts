/**
 * 往幻灯片里**新建一个文本框**（`p:sp`）。
 *
 * 拆出来的原因：仓库规矩单文件 ≤400 行；而且这段是"从零造一个形状"，与 pptShapes 里那些
 * "在既有形状上打补丁"的活计不是一类事——它得自己负责 nvSpPr / spPr / txBody 三件套与唯一 id。
 */
import { shapeNodes, writeBack } from "./pptShapes.js";

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";

function parser(): DOMParser {
  return new DOMParser();
}

/** 新建一个文本框（标题/正文这类样式不继承版式，给一套干净的默认值）。 */
export function insertTextBox(
  xml: string,
  options: { x: number; y: number; width: number; height: number; text?: string },
): { xml: string; name: string | null } {
  const document = parser().parseFromString(xml, "application/xml");
  const tree = document.getElementsByTagNameNS(P_NS, "spTree")[0];
  if (!tree) return { xml, name: null };
  const usedIds = shapeNodes(document).map((node) =>
    Number(node.getElementsByTagNameNS(P_NS, "cNvPr")[0]?.getAttribute("id") ?? 0),
  );
  const nextId = String(Math.max(0, ...usedIds) + 1);
  const existingNames = new Set(
    shapeNodes(document).map((node) =>
      node.getElementsByTagNameNS(P_NS, "cNvPr")[0]?.getAttribute("name"),
    ),
  );
  let name = "文本框";
  for (let suffix = 2; existingNames.has(name); suffix += 1) name = `文本框 ${suffix}`;

  const shape = document.createElementNS(P_NS, "p:sp");
  const nonVisual = document.createElementNS(P_NS, "p:nvSpPr");
  const properties = document.createElementNS(P_NS, "p:cNvPr");
  properties.setAttribute("id", nextId);
  properties.setAttribute("name", name);
  const nonVisualShape = document.createElementNS(P_NS, "p:cNvSpPr");
  nonVisualShape.setAttribute("txBox", "1");
  nonVisual.append(properties, nonVisualShape, document.createElementNS(P_NS, "p:nvPr"));

  const shapeProperties = document.createElementNS(P_NS, "p:spPr");
  const transform = document.createElementNS(A_NS, "a:xfrm");
  const offset = document.createElementNS(A_NS, "a:off");
  offset.setAttribute("x", String(Math.round(options.x)));
  offset.setAttribute("y", String(Math.round(options.y)));
  const extent = document.createElementNS(A_NS, "a:ext");
  extent.setAttribute("cx", String(Math.round(options.width)));
  extent.setAttribute("cy", String(Math.round(options.height)));
  transform.append(offset, extent);
  shapeProperties.append(transform);

  const body = document.createElementNS(P_NS, "txBody");
  body.append(
    document.createElementNS(A_NS, "a:bodyPr"),
    document.createElementNS(A_NS, "a:lstStyle"),
  );
  const paragraph = document.createElementNS(A_NS, "a:p");
  const run = document.createElementNS(A_NS, "a:r");
  const runProperties = document.createElementNS(A_NS, "a:rPr");
  runProperties.setAttribute("lang", "zh-CN");
  runProperties.setAttribute("sz", "1800");
  const text = document.createElementNS(A_NS, "a:t");
  text.textContent = options.text ?? "双击编辑文字";
  run.append(runProperties, text);
  paragraph.append(run);
  body.append(paragraph);

  shape.append(nonVisual, shapeProperties, body);
  tree.append(shape);
  return { xml: writeBack(document), name };
}
