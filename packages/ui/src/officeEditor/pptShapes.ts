/**
 * PPTX 的**形状层**读写：把一个 `<p:sp>` / `<p:pic>` / `<p:graphicFrame>` 当成"可编辑对象"，
 * 支持改几何、改文字格式、调层级、复制/删除/新建文本框。
 *
 * 与 pptText.ts 的分工：那边只管"文字内容"（`a:t`），这边管"这个形状本身"。
 * 两者都遵循同一条底线——**只在源 XML 上改必要的那几处**，别的部件逐字节不动。
 *
 * 身份识别用**形状名**（`p:cNvPr@name`）：渲染器给出的节点带 name 与几何，XML 里也有 name，
 * 两边一配就能"点画布上的那个框 → 改 XML 里的那个 sp"。名字重复时退化为"第一个同名"。
 */
import { patchTxBody } from "./pptText.js";
import {
  setShapeParagraphFormat,
  setShapeTextFormat,
  type ShapeParagraphFormat,
} from "./pptShapeFormat.js";

export { setShapeParagraphFormat, setShapeTextFormat };
export type { ShapeParagraphFormat };
export { insertTextBox } from "./pptShapeInsert.js";

export const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
/** 幻灯片尺寸在 OOXML 里是 EMU：1 英寸 = 914400 EMU（渲染器的几何单位也是它）。 */
export const EMU_PER_INCH = 914400;

export interface ShapeBounds {
  /** 是否从 XML 里读到了显式几何（缺省时继承版式，需要写的时候再补 a:xfrm）。 */
  explicit: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

export interface ShapeRunFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** 字号：磅（PPT 里 `sz` 是"百分之一磅"）。 */
  size?: number;
  color?: string;
  font?: string;
}

export interface PptxShape {
  /** 在幻灯片 `p:spTree` 里的序号（文档序，含组、图片；只增不改）。 */
  index: number;
  id: number;
  name: string;
  kind: "sp" | "pic" | "graphicFrame";
  /** `p:ph@type`（占位符类型），例如 title/body。 */
  placeholder?: string;
  bounds: ShapeBounds;
  /** 每个 `a:txBody` 的段落（形状一般一个；表格单元格会有多个）。 */
  textBodies: ShapeParagraphFormat[][];
  /** 首个 run 的格式（功能区要拿它显示"加粗亮着/字号 32"这类选中态）。 */
  runFormat: ShapeRunFormat;
}

function parser(): DOMParser {
  return new DOMParser();
}

function num(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 现有形状用过的 id 与名字（新建/复制时要避开）。 */
export function usedShapeIdentity(document: Document): { maxId: number; names: Set<string> } {
  const nodes = shapeNodes(document);
  const ids = nodes.map((node) =>
    Number(node.getElementsByTagNameNS(P_NS, "cNvPr")[0]?.getAttribute("id") ?? 0),
  );
  const names = new Set(
    nodes.map((node) => node.getElementsByTagNameNS(P_NS, "cNvPr")[0]?.getAttribute("name") ?? ""),
  );
  return { maxId: Math.max(0, ...ids), names };
}

export function shapeNodes(document: Document): Element[] {
  const tree = document.getElementsByTagNameNS(P_NS, "spTree")[0];
  if (!tree) return [];
  return Array.from(tree.children).filter(
    (child) =>
      child.namespaceURI === P_NS &&
      (child.localName === "sp" || child.localName === "pic" || child.localName === "graphicFrame"),
  );
}

function boundsOf(shape: Element): ShapeBounds {
  const xfrm = shape.getElementsByTagNameNS(A_NS, "xfrm")[0];
  const offset = xfrm?.getElementsByTagNameNS(A_NS, "off")[0];
  const extent = xfrm?.getElementsByTagNameNS(A_NS, "ext")[0];
  const rotationRaw = num(xfrm?.getAttribute("rot"));
  const rotation = rotationRaw === undefined ? undefined : rotationRaw / 60000;
  if (!offset || !extent) {
    return {
      explicit: false,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      ...(rotation === undefined ? {} : { rotation }),
    };
  }
  return {
    explicit: true,
    x: num(offset.getAttribute("x")) ?? 0,
    y: num(offset.getAttribute("y")) ?? 0,
    width: num(extent.getAttribute("cx")) ?? 0,
    height: num(extent.getAttribute("cy")) ?? 0,
    ...(rotation === undefined ? {} : { rotation }),
  };
}

/**
 * 首个 run 的格式（`a:rPr`）：功能区显示选中态用。
 * 只在**第一个 txBody 的第一段第一个 run** 上取样——形状当前是"整体统一样式"的粒度，
 * 多字体混排时按首个 run 报，与写入侧的口径一致。
 */
function runFormatOf(shape: Element): ShapeRunFormat {
  const body = shape.getElementsByTagNameNS("*", "txBody")[0];
  const run = body?.getElementsByTagNameNS(A_NS, "r")[0];
  const properties = run
    ? Array.from(run.children).find(
        (child) => child.namespaceURI === A_NS && child.localName === "rPr",
      )
    : undefined;
  if (!properties) return {};
  const size = num(properties.getAttribute("sz"));
  const color = properties.getElementsByTagNameNS(A_NS, "srgbClr")[0]?.getAttribute("val");
  const font = properties.getElementsByTagNameNS(A_NS, "latin")[0]?.getAttribute("typeface");
  return {
    ...(properties.getAttribute("b") === "1" ? { bold: true } : {}),
    ...(properties.getAttribute("i") === "1" ? { italic: true } : {}),
    ...(properties.getAttribute("u") && properties.getAttribute("u") !== "none"
      ? { underline: true }
      : {}),
    ...(properties.getAttribute("strike") && properties.getAttribute("strike") !== "noStrike"
      ? { strike: true }
      : {}),
    ...(size === undefined ? {} : { size: Math.round(size / 100) }),
    ...(color ? { color: `#${color}` } : {}),
    ...(font ? { font } : {}),
  };
}

function textBodiesOf(shape: Element): ShapeParagraphFormat[][] {
  return Array.from(shape.getElementsByTagNameNS("*", "txBody")).map((body) => {
    const paragraphs = Array.from(body.children).filter(
      (child) => child.namespaceURI === A_NS && child.localName === "p",
    );
    return paragraphs.map((paragraph) => {
      const properties = Array.from(paragraph.children).find(
        (child) => child.namespaceURI === A_NS && child.localName === "pPr",
      );
      const align = properties?.getAttribute("algn");
      const hasBulletNone = Boolean(properties?.getElementsByTagNameNS(A_NS, "buNone")[0]);
      const hasBulletChar = Boolean(properties?.getElementsByTagNameNS(A_NS, "buChar")[0]);
      const text = Array.from(paragraph.children)
        .filter((child) => child.namespaceURI === A_NS && child.localName === "r")
        .map((run) =>
          Array.from(run.getElementsByTagNameNS(A_NS, "t"))
            .map((node) => node.textContent ?? "")
            .join(""),
        )
        .join("");
      return {
        lines: [text],
        ...(align === "ctr" || align === "r" || align === "just" || align === "l"
          ? {
              align:
                align === "ctr"
                  ? "center"
                  : align === "r"
                    ? "right"
                    : align === "just"
                      ? "justify"
                      : "left",
            }
          : {}),
        ...(hasBulletNone ? { bullet: false } : hasBulletChar ? { bullet: true } : {}),
      } satisfies ShapeParagraphFormat;
    });
  });
}

/** 读一张幻灯片里的所有形状（几何 + 段落格式）。 */
export function readSlideShapes(xml: string): PptxShape[] {
  const document = parser().parseFromString(xml, "application/xml");
  return shapeNodes(document).map((shape, index) => {
    const properties = shape.getElementsByTagNameNS(P_NS, "cNvPr")[0];
    const placeholder = shape.getElementsByTagNameNS(P_NS, "ph")[0]?.getAttribute("type");
    const kind =
      shape.localName === "pic"
        ? "pic"
        : shape.localName === "graphicFrame"
          ? "graphicFrame"
          : "sp";
    return {
      index,
      id: num(properties?.getAttribute("id")) ?? 0,
      name: properties?.getAttribute("name") ?? "",
      kind,
      ...(placeholder ? { placeholder } : {}),
      bounds: boundsOf(shape),
      textBodies: textBodiesOf(shape),
      runFormat: runFormatOf(shape),
    } satisfies PptxShape;
  });
}

export function writeBack(document: Document): string {
  return new XMLSerializer().serializeToString(document);
}

export function shapeByName(document: Document, name: string): Element | undefined {
  return shapeNodes(document).find(
    (shape) => shape.getElementsByTagNameNS(P_NS, "cNvPr")[0]?.getAttribute("name") === name,
  );
}

/** 该形状的几何容器：`p:spPr` / `p:grpSpPr` / `p:xfrm`（图片在 `p:spPr` 里）。 */
function transformContainer(shape: Element): Element {
  return (
    shape.getElementsByTagNameNS(P_NS, "spPr")[0] ??
    shape.getElementsByTagNameNS(P_NS, "grpSpPr")[0] ??
    shape
  );
}

/**
 * 改形状的**位置与大小**。没有显式 `a:xfrm` 时补一个（继承版式的形状要动它必须先落成显式值）。
 */
export function setShapeBounds(
  xml: string,
  shapeName: string,
  bounds: Partial<ShapeBounds>,
): string {
  const document = parser().parseFromString(xml, "application/xml");
  const shape = shapeByName(document, shapeName);
  if (!shape) return xml;
  const container = transformContainer(shape);
  let xfrm = container.getElementsByTagNameNS(A_NS, "xfrm")[0];
  if (!xfrm) {
    xfrm = document.createElementNS(A_NS, "a:xfrm");
    container.insertBefore(xfrm, container.firstChild);
  }
  let offset = xfrm.getElementsByTagNameNS(A_NS, "off")[0];
  let extent = xfrm.getElementsByTagNameNS(A_NS, "ext")[0];
  if (!offset) {
    offset = document.createElementNS(A_NS, "a:off");
    offset.setAttribute("x", "0");
    offset.setAttribute("y", "0");
    xfrm.append(offset);
  }
  if (!extent) {
    extent = document.createElementNS(A_NS, "a:ext");
    extent.setAttribute("cx", "914400");
    extent.setAttribute("cy", "914400");
    xfrm.append(extent);
  }
  if (bounds.x !== undefined) offset.setAttribute("x", String(Math.round(bounds.x)));
  if (bounds.y !== undefined) offset.setAttribute("y", String(Math.round(bounds.y)));
  if (bounds.width !== undefined) extent.setAttribute("cx", String(Math.round(bounds.width)));
  if (bounds.height !== undefined) extent.setAttribute("cy", String(Math.round(bounds.height)));
  // OOXML 的 rot 单位是**60000 分之一度**（写得数会转出肉眼看不见的角度，等于没转）
  if (bounds.rotation !== undefined)
    xfrm.setAttribute("rot", String(Math.round((((bounds.rotation % 360) + 360) % 360) * 60000)));
  return writeBack(document);
}

/**
 * 该形状下第一个 `txBody`（没有就造一个空的）。
 *
 * ⚠️ **`txBody` 有两个命名空间**：形状里是 `p:txBody`（PresentationML）、表格单元格里是
 * `a:txBody`（DrawingML）。只认一个的话，形状的文字格式会"改了没反应"（实测踩过）；
 * 新建时也要按形状的类型用对前缀——`p:sp` 里塞 `a:txBody` 是无效的。
 */
/** 形状的文字内容（段落 → 行），供检查器初始化。 */
export function shapeLines(shape: PptxShape): string[] {
  const body = shape.textBodies[0];
  if (!body) return [];
  return body.flatMap((paragraph) => paragraph.lines);
}

/** 改形状文字（内部走 pptText 的段落改写，保持"首个 run 承载全文"的口径一致）。 */
export function setShapeText(xml: string, shapeName: string, lines: string[]): string {
  const document = parser().parseFromString(xml, "application/xml");
  const shapes = shapeNodes(document);
  const index = shapes.findIndex(
    (shape) => shape.getElementsByTagNameNS(P_NS, "cNvPr")[0]?.getAttribute("name") === shapeName,
  );
  if (index < 0) return xml;
  const bodies = Array.from(document.getElementsByTagNameNS("*", "txBody"));
  const bodyIndex = bodies.indexOf(
    shapes[index]?.getElementsByTagNameNS("*", "txBody")[0] as Element,
  );
  if (bodyIndex < 0) return xml;
  return patchTxBody(xml, bodyIndex, lines);
}

/** 层级：把形状往前/往后挪一位（`p:spTree` 里 children 的顺序就是 z 序）。 */
export function moveShapeZ(xml: string, shapeName: string, direction: "up" | "down"): string {
  const document = parser().parseFromString(xml, "application/xml");
  const tree = document.getElementsByTagNameNS(P_NS, "spTree")[0];
  if (!tree) return xml;
  const shape = shapeByName(document, shapeName);
  if (!shape) return xml;
  const siblings = Array.from(tree.children).filter(
    (child) =>
      child.namespaceURI === P_NS &&
      child.localName !== "nvGrpSpPr" &&
      child.localName !== "grpSpPr",
  );
  const position = siblings.indexOf(shape);
  const target = direction === "up" ? position + 1 : position - 1;
  if (position < 0 || target < 0 || target >= siblings.length) return xml;
  const other = siblings[target];
  if (!other) return xml;
  if (direction === "up") tree.insertBefore(other, shape);
  else tree.insertBefore(shape, other);
  return writeBack(document);
}

/** 删除形状。 */
export function deleteShape(xml: string, shapeName: string): string {
  const document = parser().parseFromString(xml, "application/xml");
  const shape = shapeByName(document, shapeName);
  if (!shape) return xml;
  shape.remove();
  return writeBack(document);
}

/** 复制形状（新 id、名字加"副本"、位置略偏移，别的属性照抄）。 */
export function duplicateShape(
  xml: string,
  shapeName: string,
): { xml: string; name: string | null } {
  const document = parser().parseFromString(xml, "application/xml");
  const tree = document.getElementsByTagNameNS(P_NS, "spTree")[0];
  const shape = shapeByName(document, shapeName);
  if (!tree || !shape) return { xml, name: null };
  const clone = shape.cloneNode(true) as Element;
  const properties = clone.getElementsByTagNameNS(P_NS, "cNvPr")[0];
  const usedIds = shapeNodes(document).map((node) =>
    Number(node.getElementsByTagNameNS(P_NS, "cNvPr")[0]?.getAttribute("id") ?? 0),
  );
  const nextId = String(Math.max(0, ...usedIds) + 1);
  const baseName = shapeName.replace(/ 副本( \d+)?$/, "");
  const existingNames = new Set(
    shapeNodes(document).map((node) =>
      node.getElementsByTagNameNS(P_NS, "cNvPr")[0]?.getAttribute("name"),
    ),
  );
  let nextName = `${baseName} 副本`;
  for (let suffix = 2; existingNames.has(nextName); suffix += 1)
    nextName = `${baseName} 副本 ${suffix}`;
  if (properties) {
    properties.setAttribute("id", nextId);
    properties.setAttribute("name", nextName);
  }
  // 偏移一点，免得完全盖住原件
  const xfrm = clone.getElementsByTagNameNS(A_NS, "xfrm")[0];
  const offset = xfrm?.getElementsByTagNameNS(A_NS, "off")[0];
  if (offset) {
    offset.setAttribute("x", String((num(offset.getAttribute("x")) ?? 0) + EMU_PER_INCH / 4));
    offset.setAttribute("y", String((num(offset.getAttribute("y")) ?? 0) + EMU_PER_INCH / 4));
  }
  shape.after(clone);
  return { xml: writeBack(document), name: nextName };
}
