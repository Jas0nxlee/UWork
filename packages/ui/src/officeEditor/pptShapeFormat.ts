/**
 * 形状的**文字/段落格式**补丁：粗斜下划线删除线、字号、颜色、字体、对齐、项目符号。
 *
 * 拆出来的原因：仓库规矩单文件 ≤400 行；而"格式"与"几何/身份"本来也是两件事。
 * 粒度：当前是**整个形状统一**（不做"选中一段"），这是本轮的范围。
 */
import { P_NS, shapeByName, writeBack, type ShapeRunFormat } from "./pptShapes.js";

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

function parser(): DOMParser {
  return new DOMParser();
}

export interface ShapeParagraphFormat {
  align?: "left" | "center" | "right" | "justify";
  bullet?: boolean;
  lines: string[];
}

function ensureTextBody(document: Document, shape: Element): Element {
  const existing = shape.getElementsByTagNameNS("*", "txBody")[0];
  if (existing) return existing;
  const body = document.createElementNS(P_NS, "p:txBody");
  body.append(
    document.createElementNS(A_NS, "a:bodyPr"),
    document.createElementNS(A_NS, "a:lstStyle"),
    document.createElementNS(A_NS, "a:p"),
  );
  shape.append(body);
  return body;
}

/** 段落属性容器（`a:pPr`），没有就在段落开头插一个。 */
function ensureParagraphProperties(document: Document, paragraph: Element): Element {
  const existing = Array.from(paragraph.children).find(
    (child) => child.namespaceURI === A_NS && child.localName === "pPr",
  );
  if (existing) return existing;
  const properties = document.createElementNS(A_NS, "a:pPr");
  paragraph.insertBefore(properties, paragraph.firstChild);
  return properties;
}

/** run 属性容器（`a:rPr`），没有就在 run 开头插一个。 */
function ensureRunProperties(document: Document, run: Element): Element {
  const existing = Array.from(run.children).find(
    (child) => child.namespaceURI === A_NS && child.localName === "rPr",
  );
  if (existing) return existing;
  const properties = document.createElementNS(A_NS, "a:rPr");
  properties.setAttribute("lang", "zh-CN");
  run.insertBefore(properties, run.firstChild);
  return properties;
}

function runsOf(shape: Element): Element[] {
  const body = shape.getElementsByTagNameNS("*", "txBody")[0];
  if (!body) return [];
  return Array.from(body.getElementsByTagNameNS(A_NS, "r"));
}

/**
 * 改某个形状里**所有文字**的格式（本轮粒度：整个形状统一，不做"选中一段"）。
 * 传 undefined 表示"这一位不动"；传 false / 空串表示"清掉"。
 */

export function setShapeTextFormat(xml: string, shapeName: string, format: ShapeRunFormat): string {
  const document = parser().parseFromString(xml, "application/xml");
  const shape = shapeByName(document, shapeName);
  if (!shape) return xml;
  // 只有 p:sp 能直接挂文字（图片/表格不行：表格的文字在单元格里）
  if (shape.localName !== "sp" && !shape.getElementsByTagNameNS("*", "txBody")[0]) return xml;
  ensureTextBody(document, shape);
  for (const run of runsOf(shape)) {
    const properties = ensureRunProperties(document, run);
    if (format.bold !== undefined) properties.setAttribute("b", format.bold ? "1" : "0");
    if (format.italic !== undefined) properties.setAttribute("i", format.italic ? "1" : "0");
    if (format.underline !== undefined)
      properties.setAttribute("u", format.underline ? "sng" : "none");
    if (format.strike !== undefined)
      properties.setAttribute("strike", format.strike ? "sngStrike" : "noStrike");
    if (format.size !== undefined) {
      if (format.size > 0) properties.setAttribute("sz", String(Math.round(format.size * 100)));
      else properties.removeAttribute("sz");
    }
    if (format.font !== undefined) {
      const latin =
        properties.getElementsByTagNameNS(A_NS, "latin")[0] ??
        document.createElementNS(A_NS, "a:latin");
      if (format.font) latin.setAttribute("typeface", format.font);
      else latin.removeAttribute("typeface");
      if (!latin.parentElement) properties.append(latin);
    }
    if (format.color !== undefined) {
      for (const fill of Array.from(properties.getElementsByTagNameNS(A_NS, "solidFill")))
        fill.remove();
      if (format.color) {
        const fill = document.createElementNS(A_NS, "a:solidFill");
        const color = document.createElementNS(A_NS, "a:srgbClr");
        color.setAttribute("val", format.color.replace(/^#/, "").toUpperCase());
        fill.append(color);
        // `a:solidFill` 在 `a:rPr` 里必须排在 latin/ln 之类的**前面**
        properties.insertBefore(fill, properties.firstChild);
      }
    }
  }
  return writeBack(document);
}

/** 段落对齐与项目符号（整个形状统一）。 */
export function setShapeParagraphFormat(
  xml: string,
  shapeName: string,
  format: { align?: ShapeParagraphFormat["align"]; bullet?: boolean },
): string {
  const document = parser().parseFromString(xml, "application/xml");
  const shape = shapeByName(document, shapeName);
  if (!shape) return xml;
  if (shape.localName !== "sp" && !shape.getElementsByTagNameNS("*", "txBody")[0]) return xml;
  const body = ensureTextBody(document, shape);
  const paragraphs = Array.from(body.children).filter(
    (child) => child.namespaceURI === A_NS && child.localName === "p",
  );
  for (const paragraph of paragraphs) {
    const properties = ensureParagraphProperties(document, paragraph);
    if (format.align !== undefined) {
      const value =
        format.align === "center"
          ? "ctr"
          : format.align === "right"
            ? "r"
            : format.align === "justify"
              ? "just"
              : "l";
      properties.setAttribute("algn", value);
    }
    if (format.bullet !== undefined) {
      for (const bullet of [
        ...Array.from(properties.getElementsByTagNameNS(A_NS, "buNone")),
        ...Array.from(properties.getElementsByTagNameNS(A_NS, "buChar")),
        ...Array.from(properties.getElementsByTagNameNS(A_NS, "buAutoNum")),
      ]) {
        bullet.remove();
      }
      if (format.bullet) {
        const char = document.createElementNS(A_NS, "a:buChar");
        char.setAttribute("char", "•");
        // pPr 的子元素有顺序要求：项目符号要在 `a:lnSpc`/`a:spcBef` 之后、`a:defRPr` 之前
        properties.append(char);
      } else {
        properties.append(document.createElementNS(A_NS, "a:buNone"));
      }
    }
  }
  return writeBack(document);
}
