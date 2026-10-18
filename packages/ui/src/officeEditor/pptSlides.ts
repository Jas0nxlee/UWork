/**
 * PPTX 的**幻灯片级操作**：新建 / 复制 / 删除 / 调顺序。
 *
 * 这些都落在 `ppt/presentation.xml`（`p:sldIdLst` 的次序就是放映顺序）、它的 `.rels`、
 * 以及 `[Content_Types].xml`（新部件要登记），再加上新增/删除的 `ppt/slides/slideN.xml`。
 * **其余部件逐字节不动**——包括母版、版式、主题、媒体。
 *
 * 顺序的正确来源是 `p:sldIdLst`（不是 slideN.xml 的文件名）：PowerPoint 完全可以让
 * 第 1 页叫 slide7.xml。所以这里的读写都以 `sldIdLst` 为准。
 */
import JSZip from "jszip";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const SLIDE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";

export interface SlideEntry {
  /** `ppt/slides/slideN.xml`。 */
  partName: string;
  /** 放映顺序（0 基，按 `p:sldIdLst`）。 */
  order: number;
  /** `p:sldId@id`。 */
  sldId: number;
  /** `r:id`（在 presentation.xml.rels 里）。 */
  relationshipId: string;
}

function parser(): DOMParser {
  return new DOMParser();
}

function serialize(document: Document): string {
  return new XMLSerializer().serializeToString(document);
}

/** 放映顺序 → 部件名（按 `p:sldIdLst`，不是按文件名排序）。 */
export async function readSlideOrder(
  bytes: ArrayBuffer,
): Promise<{ entries: SlideEntry[]; parts: Map<string, string> }> {
  // JSZip 会消费传入的 buffer（实测：同一份 ArrayBuffer 第二次 load 就报"读不到数据"），
  // 所以入口一律拿副本——调用方不用操心 buffer 的生命周期
  const zip = await JSZip.loadAsync(bytes.slice(0));
  const presentationXml = (await zip.file("ppt/presentation.xml")?.async("string")) ?? "";
  const relsXml = (await zip.file("ppt/_rels/presentation.xml.rels")?.async("string")) ?? "";
  const document = parser().parseFromString(presentationXml, "application/xml");
  const relDocument = parser().parseFromString(relsXml, "application/xml");
  const targets = new Map<string, string>();
  for (const rel of Array.from(relDocument.getElementsByTagNameNS(REL_NS, "Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) {
      targets.set(
        id,
        target.startsWith("/") ? target.slice(1) : `ppt/${target.replace(/^\.\//, "")}`,
      );
    }
  }
  const entries: SlideEntry[] = [];
  const slideIds = Array.from(document.getElementsByTagNameNS(P_NS, "sldId"));
  slideIds.forEach((node, order) => {
    const relationshipId = node.getAttributeNS(R_NS, "id") ?? node.getAttribute("r:id") ?? "";
    const partName = targets.get(relationshipId);
    if (!partName) return;
    entries.push({
      partName,
      order,
      sldId: Number(node.getAttribute("id") ?? 0),
      relationshipId,
    });
  });
  const parts = new Map<string, string>();
  for (const entry of entries) {
    parts.set(entry.partName, (await zip.file(entry.partName)?.async("string")) ?? "");
  }
  return { entries, parts };
}

function nextSlideFileName(entries: SlideEntry[], zip: JSZip): string {
  const used = new Set(
    Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)),
  );
  let index = 1;
  while (used.has(`ppt/slides/slide${index}.xml`)) index += 1;
  void entries;
  return `ppt/slides/slide${index}.xml`;
}

/** 一张"空白"幻灯片：抄现成的版式关系，正文空着。 */
async function blankSlideXml(zip: JSZip, templatePart: string | undefined): Promise<string> {
  const layoutTarget = templatePart
    ? await (async () => {
        const rels = await zip
          .file(`ppt/slides/_rels/${templatePart.split("/").pop() ?? ""}.rels`)
          ?.async("string");
        if (!rels) return undefined;
        const document = parser().parseFromString(rels, "application/xml");
        return Array.from(document.getElementsByTagNameNS(REL_NS, "Relationship"))
          .find((rel) => (rel.getAttribute("Type") ?? "").endsWith("/slideLayout"))
          ?.getAttribute("Target");
      })()
    : undefined;
  void layoutTarget;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="${P_NS}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

/** 在 `p:sldIdLst` 里改顺序 / 增删条目，并同步 rels 与 Content_Types。 */
async function rewriteDeck(input: {
  source: ArrayBuffer;
  mutate: (context: {
    presentation: Document;
    rels: Document;
    contentTypes: Document;
    zip: JSZip;
    entries: SlideEntry[];
  }) => Promise<void> | void;
}): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(input.source.slice(0));
  const { entries, parts } = await readSlideOrder(input.source);
  const presentation = parser().parseFromString(
    (await zip.file("ppt/presentation.xml")?.async("string")) ?? "",
    "application/xml",
  );
  const rels = parser().parseFromString(
    (await zip.file("ppt/_rels/presentation.xml.rels")?.async("string")) ?? "",
    "application/xml",
  );
  const contentTypes = parser().parseFromString(
    (await zip.file("[Content_Types].xml")?.async("string")) ?? "",
    "application/xml",
  );
  for (const [name, xml] of parts) zip.file(name, xml);
  await input.mutate({ presentation, rels, contentTypes, zip, entries });
  zip.file("ppt/presentation.xml", serialize(presentation));
  zip.file("ppt/_rels/presentation.xml.rels", serialize(rels));
  zip.file("[Content_Types].xml", serialize(contentTypes));
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

/** 新建一张空白幻灯片（插到 `at` 位置，默认末尾）。 */
export function addSlide(input: {
  source: ArrayBuffer;
  at?: number;
  templatePart?: string;
}): Promise<ArrayBuffer> {
  return rewriteDeck({
    source: input.source,
    mutate: async ({ presentation, rels, contentTypes, zip, entries }) => {
      const partName = nextSlideFileName(entries, zip);
      zip.file(partName, await blankSlideXml(zip, input.templatePart ?? entries[0]?.partName));
      const nextRelId = `rId${Math.max(0, ...Array.from(rels.getElementsByTagNameNS(REL_NS, "Relationship")).map((rel) => Number((rel.getAttribute("Id") ?? "").replace(/\D/g, "")) || 0)) + 1}`;
      const relationship = rels.createElementNS(REL_NS, "Relationship");
      relationship.setAttribute("Id", nextRelId);
      relationship.setAttribute("Type", SLIDE_REL_TYPE);
      relationship.setAttribute("Target", partName.replace(/^ppt\//, ""));
      rels.documentElement.append(relationship);
      const override = contentTypes.createElementNS(CT_NS, "Override");
      override.setAttribute("PartName", `/${partName}`);
      override.setAttribute("ContentType", SLIDE_CONTENT_TYPE);
      contentTypes.documentElement.append(override);

      const list = presentation.getElementsByTagNameNS(P_NS, "sldIdLst")[0];
      if (!list) return;
      const node = presentation.createElementNS(P_NS, "p:sldId");
      const nextId =
        Math.max(
          255,
          ...Array.from(list.getElementsByTagNameNS(P_NS, "sldId")).map((item) =>
            Number(item.getAttribute("id") ?? 0),
          ),
        ) + 1;
      node.setAttribute("id", String(nextId));
      node.setAttributeNS(R_NS, "r:id", nextRelId);
      const slideIds = Array.from(list.getElementsByTagNameNS(P_NS, "sldId"));
      const at = Math.max(0, Math.min(input.at ?? slideIds.length, slideIds.length));
      if (at >= slideIds.length) list.append(node);
      else list.insertBefore(node, slideIds[at] ?? null);
    },
  });
}

/** 复制一张幻灯片（放到它后面）。 */
export function duplicateSlide(input: {
  source: ArrayBuffer;
  partName: string;
}): Promise<ArrayBuffer> {
  return rewriteDeck({
    source: input.source,
    mutate: async ({ presentation, rels, contentTypes, zip, entries }) => {
      const sourceEntry = entries.find((entry) => entry.partName === input.partName);
      if (!sourceEntry) return;
      const partName = nextSlideFileName(entries, zip);
      zip.file(partName, (await zip.file(input.partName)?.async("string")) ?? "");
      // 幻灯片自己的关系（图片/图表等）整份抄过来，目标名跟着改
      const relsFile = `ppt/slides/_rels/${input.partName.split("/").pop() ?? ""}.rels`;
      const relsXml = await zip.file(relsFile)?.async("string");
      if (relsXml) {
        zip.file(`ppt/slides/_rels/${partName.split("/").pop() ?? ""}.rels`, relsXml);
      }
      const nextRelId = `rId${Math.max(0, ...Array.from(rels.getElementsByTagNameNS(REL_NS, "Relationship")).map((rel) => Number((rel.getAttribute("Id") ?? "").replace(/\D/g, "")) || 0)) + 1}`;
      const relationship = rels.createElementNS(REL_NS, "Relationship");
      relationship.setAttribute("Id", nextRelId);
      relationship.setAttribute("Type", SLIDE_REL_TYPE);
      relationship.setAttribute("Target", partName.replace(/^ppt\//, ""));
      rels.documentElement.append(relationship);
      const override = contentTypes.createElementNS(CT_NS, "Override");
      override.setAttribute("PartName", `/${partName}`);
      override.setAttribute("ContentType", SLIDE_CONTENT_TYPE);
      contentTypes.documentElement.append(override);

      const list = presentation.getElementsByTagNameNS(P_NS, "sldIdLst")[0];
      if (!list) return;
      const slideIds = Array.from(list.getElementsByTagNameNS(P_NS, "sldId"));
      const node = presentation.createElementNS(P_NS, "p:sldId");
      const nextId =
        Math.max(255, ...slideIds.map((item) => Number(item.getAttribute("id") ?? 0))) + 1;
      node.setAttribute("id", String(nextId));
      node.setAttributeNS(R_NS, "r:id", nextRelId);
      const index = entries.findIndex((entry) => entry.partName === input.partName);
      list.insertBefore(node, slideIds[index + 1] ?? null);
    },
  });
}

/** 删除一张幻灯片（部件、关系、Content_Types 条目一起清）。 */
export function deleteSlide(input: {
  source: ArrayBuffer;
  partName: string;
}): Promise<ArrayBuffer> {
  return rewriteDeck({
    source: input.source,
    mutate: ({ presentation, rels, contentTypes, zip, entries }) => {
      const entry = entries.find((item) => item.partName === input.partName);
      if (!entry || entries.length <= 1) return;
      zip.remove(input.partName);
      zip.remove(`ppt/slides/_rels/${input.partName.split("/").pop() ?? ""}.rels`);
      for (const node of Array.from(rels.getElementsByTagNameNS(REL_NS, "Relationship"))) {
        if (node.getAttribute("Id") === entry.relationshipId) node.remove();
      }
      for (const node of Array.from(contentTypes.getElementsByTagNameNS(CT_NS, "Override"))) {
        if (node.getAttribute("PartName") === `/${input.partName}`) node.remove();
      }
      const list = presentation.getElementsByTagNameNS(P_NS, "sldIdLst")[0];
      const slideIds = list ? Array.from(list.getElementsByTagNameNS(P_NS, "sldId")) : [];
      for (const node of slideIds) {
        if ((node.getAttributeNS(R_NS, "id") ?? node.getAttribute("r:id")) === entry.relationshipId)
          node.remove();
      }
    },
  });
}

/** 调顺序：把 `partName` 挪到 `to`（0 基，放映顺序）。 */
export function moveSlide(input: {
  source: ArrayBuffer;
  partName: string;
  to: number;
}): Promise<ArrayBuffer> {
  return rewriteDeck({
    source: input.source,
    mutate: ({ presentation, entries }) => {
      const list = presentation.getElementsByTagNameNS(P_NS, "sldIdLst")[0];
      if (!list) return;
      const slideIds = Array.from(list.getElementsByTagNameNS(P_NS, "sldId"));
      const from = entries.findIndex((entry) => entry.partName === input.partName);
      if (from < 0) return;
      const node = slideIds[from];
      if (!node) return;
      const target = Math.max(0, Math.min(input.to, slideIds.length - 1));
      node.remove();
      const remaining = Array.from(list.getElementsByTagNameNS(P_NS, "sldId"));
      if (target >= remaining.length) list.append(node);
      else list.insertBefore(node, remaining[target] ?? null);
    },
  });
}
