/**
 * **讲稿备注**的读写：`ppt/notesSlides/notesSlideN.xml`。
 *
 * 与幻灯片的关系靠**这一页的 `.rels`**（`.../notesSlide` 类型）找，不靠文件名猜——
 * PowerPoint 完全可以让第 1 页的备注叫 notesSlide7.xml。
 *
 * 两件事分开：
 *   - **改已有的备注**：只改那个 notesSlide 里的正文 `txBody`（一个字都不动别处）；
 *   - **给没有备注的页加备注**：要**新建部件**（notesSlide + 这一页的 rel + `[Content_Types].xml` 登记），
 *     那就是"包级手术"了，和插入图片/新建幻灯片同一类，走 deck 补丁通道。
 */
import JSZip from "jszip";

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NOTES_REL_TYPE = `${R_NS}/notesSlide`;
const NOTES_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";

function parser(): DOMParser {
  return new DOMParser();
}

function relsNameOf(partName: string): string {
  // 别用 `split(/(?=[^/]+$)/)`：那个零宽前瞻在**最后一段的每个位置**都命中，拆出来是
  // ["ppt/slides/", "s", "l", …]，rels 名会变成 `…/_rels/s.xml.rels`——找不到就静默当"没有备注"。
  const cut = partName.lastIndexOf("/");
  return `${partName.slice(0, cut + 1)}_rels/${partName.slice(cut + 1)}.rels`;
}

/** 这一页的备注部件名（没有备注返回 null）。 */
export async function notesPartOf(bytes: ArrayBuffer, slidePart: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(bytes.slice(0));
  const rels = (await zip.file(relsNameOf(slidePart))?.async("string")) ?? "";
  if (!rels) return null;
  const document = parser().parseFromString(rels, "application/xml");
  for (const rel of Array.from(document.getElementsByTagNameNS(REL_NS, "Relationship"))) {
    if (rel.getAttribute("Type") !== NOTES_REL_TYPE) continue;
    const target = rel.getAttribute("Target") ?? "";
    if (!target) continue;
    const resolved = target.startsWith("/")
      ? target.slice(1)
      : target.startsWith("../")
        ? `ppt/${target.replace(/^\.\.\//, "")}`
        : `ppt/slides/${target}`;
    return resolved;
  }
  return null;
}

/**
 * 备注正文本体的 txBody 在**整份 notes 部件**里的序号（`patchTxBody` 按这个序号改）。
 *
 * 先认 `p:ph type="body"` 那个占位符：真备注页里还有"幻灯片图像/页码"占位符，而**页码占位符里
 * 是有字的**（`<a:fld type="slidenum"><a:t>3</a:t></a:fld>`）。按"第一个有字的 txBody"认，
 * 就会把页码当备注读出来、写回去还会把备注塞进页码占位符——悄悄改坏这一页。
 * 老文件里偶尔没有 ph 类型，那时才退回"第一个有字的 txBody"。
 */
function notesBodyIndexIn(document: Document): number | null {
  const bodies = Array.from(document.getElementsByTagNameNS("*", "txBody"));
  const bodyShape = Array.from(document.getElementsByTagNameNS(P_NS, "sp")).find((shape) =>
    Array.from(shape.getElementsByTagNameNS(P_NS, "ph")).some(
      (ph) => ph.getAttribute("type") === "body",
    ),
  );
  const inShape = bodyShape ? bodies.find((candidate) => bodyShape.contains(candidate)) : undefined;
  if (inShape) return bodies.indexOf(inShape);
  const withText = bodies.find((candidate) =>
    Array.from(candidate.getElementsByTagNameNS(A_NS, "p")).some((paragraph) =>
      Boolean(paragraph.getElementsByTagNameNS(A_NS, "t")[0]),
    ),
  );
  return withText ? bodies.indexOf(withText) : null;
}

/** 备注里的正文（把正文占位符的段落拼成行；没有备注部件就返回空数组）。 */
export function readNotesText(xml: string): string[] {
  const document = parser().parseFromString(xml, "application/xml");
  const bodies = Array.from(document.getElementsByTagNameNS("*", "txBody"));
  const index = notesBodyIndexIn(document);
  const body = index === null ? undefined : bodies[index];
  if (!body) return [];
  return Array.from(body.children)
    .filter((child) => child.namespaceURI === A_NS && child.localName === "p")
    .map((paragraph) =>
      Array.from(paragraph.getElementsByTagNameNS(A_NS, "t"))
        .map((node) => node.textContent ?? "")
        .join(""),
    )
    .filter((line, index, all) => line !== "" || index < all.length - 1);
}

/**
 * 改备注正文：**只改那一个 txBody**（按它在本页里的序号交给 `patchTxBody` —— 段落改写、
 * 沿用首段样式那条路已经被回归盯住了）。
 */
export function notesBodyIndex(xml: string): number | null {
  return notesBodyIndexIn(parser().parseFromString(xml, "application/xml"));
}

/** 备注页里正文占位符的形状名（有的引擎按名字改更稳，这里留作排查用）。 */
export function notesBodyShapeName(xml: string): string | null {
  const document = parser().parseFromString(xml, "application/xml");
  const shapes = Array.from(document.getElementsByTagNameNS(P_NS, "sp"));
  const named = (shape: Element) =>
    shape.getElementsByTagNameNS(P_NS, "cNvPr")[0]?.getAttribute("name") ?? null;
  const body = shapes.find((shape) =>
    Array.from(shape.getElementsByTagNameNS(P_NS, "ph")).some(
      (ph) => ph.getAttribute("type") === "body",
    ),
  );
  if (body) return named(body);
  const withText = shapes.find((candidate) =>
    Boolean(candidate.getElementsByTagNameNS(A_NS, "t")[0]),
  );
  return withText ? named(withText) : null;
}

export interface AddNotesResult {
  bytes: ArrayBuffer;
  partName: string;
}

/**
 * 给**没有备注**的幻灯片新建一个备注页（部件 + 这一页的 rel + Content_Types 登记）。
 * 新建的备注页是空正文 + 一个正文占位符，之后就按"改已有备注"那条路改了。
 */
export async function addNotesSlide(
  bytes: ArrayBuffer,
  slidePart: string,
  templatePart?: string | null,
): Promise<AddNotesResult> {
  const zip = await JSZip.loadAsync(bytes.slice(0));
  const names = Object.keys(zip.files);
  let index = 1;
  while (names.includes(`ppt/notesSlides/notesSlide${index}.xml`)) index += 1;
  const partName = `ppt/notesSlides/notesSlide${index}.xml`;

  // ① 内容：优先克隆模板备注页（保留主题/母版关系），没有就写一个最小合法备注页
  const template = templatePart ? await zip.file(templatePart)?.async("string") : undefined;
  const xml =
    template && template.trim().startsWith("<")
      ? template
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:notes xmlns:p="${P_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
        `<p:sp><p:nvSpPr><p:cNvPr id="2" name="备注占位符"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>` +
        `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
  zip.file(partName, xml);

  // ② 这一页的 rels：加一条 notesSlide 关系
  const relsName = relsNameOf(slidePart);
  const rels =
    (await zip.file(relsName)?.async("string")) ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}"/>`;
  const relDocument = parser().parseFromString(rels, "application/xml");
  const used = new Set(
    Array.from(relDocument.getElementsByTagNameNS(REL_NS, "Relationship")).map(
      (rel) => rel.getAttribute("Id") ?? "",
    ),
  );
  let relId = "";
  for (let candidate = 1; candidate <= used.size + 1; candidate += 1) {
    if (!used.has(`rId${candidate}`)) {
      relId = `rId${candidate}`;
      break;
    }
  }
  if (!relId) relId = `rId${used.size + 1}`;
  const relationship = relDocument.createElementNS(REL_NS, "Relationship");
  relationship.setAttribute("Id", relId);
  relationship.setAttribute("Type", NOTES_REL_TYPE);
  relationship.setAttribute("Target", `../notesSlides/${partName.split("/").pop() ?? ""}`);
  relDocument.documentElement.append(relationship);
  zip.file(relsName, new XMLSerializer().serializeToString(relDocument));

  // ③ Content_Types：登记这个部件
  const contentTypesName = "[Content_Types].xml";
  const contentTypesXml = (await zip.file(contentTypesName)?.async("string")) ?? "";
  if (contentTypesXml && !contentTypesXml.includes(`PartName="/${partName}"`)) {
    const contentTypes = parser().parseFromString(contentTypesXml, "application/xml");
    const override = contentTypes.createElementNS(CT_NS, "Override");
    override.setAttribute("PartName", `/${partName}`);
    override.setAttribute("ContentType", NOTES_CONTENT_TYPE);
    contentTypes.documentElement.append(override);
    zip.file(contentTypesName, new XMLSerializer().serializeToString(contentTypes));
  }

  const out = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return { bytes: out, partName };
}
