/** 独立的 OOXML 形状原语；聚合入口和格式/插入实现共同依赖，避免循环依赖。 */
export const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
/** 幻灯片尺寸在 OOXML 里是 EMU：1 英寸 = 914400 EMU（渲染器的几何单位也是它）。 */
export const EMU_PER_INCH = 914400;

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

export function shapeNodes(document: Document): Element[] {
  const tree = document.getElementsByTagNameNS(P_NS, "spTree")[0];
  if (!tree) return [];
  return Array.from(tree.children).filter(
    (child) =>
      child.namespaceURI === P_NS &&
      (child.localName === "sp" || child.localName === "pic" || child.localName === "graphicFrame"),
  );
}

export function writeBack(document: Document): string {
  return new XMLSerializer().serializeToString(document);
}

export function shapeByName(document: Document, name: string): Element | undefined {
  return shapeNodes(document).find(
    (shape) => shape.getElementsByTagNameNS(P_NS, "cNvPr")[0]?.getAttribute("name") === name,
  );
}
