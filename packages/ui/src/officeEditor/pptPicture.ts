/**
 * **往幻灯片里插图片**（本机选图 → 内嵌进 pptx）。
 *
 * 为什么走"补丁 zip"而不是"整份重写"：图片是新增部件（`ppt/media/imageN.*`），还要动
 * 这一页的 `.rels` 与 `[Content_Types].xml`。这些都属于"包级手术"，与幻灯片增删是同一类，
 * 所以复用 deck 补丁通道（改完把滑块 XML 读回来，其余部件仍然逐字节保留）。
 *
 * 尺寸：按图片原始宽高比**等比放进页面**（默认最多占页面宽的 60%、高的 50%），居中摆放——
 * 不猜、也不用用户先填数。图片自身的像素尺寸在浏览器里用 `createImageBitmap` 读。
 */
import JSZip from "jszip";
import { A_NS, P_NS } from "./pptShapes.js";

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const IMAGE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

/** data URI（`data:image/png;base64,…`）→ 扩展名 + 字节。 */
export function decodeImageDataUri(dataUri: string): { extension: string; bytes: Uint8Array } {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUri.trim());
  if (!match) throw new Error("不是合法的图片 data URI");
  const mime = match[1] ?? "image/png";
  const base64 = match[2] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const extension = mime === "image/jpeg" ? "jpeg" : (mime.split("/")[1] ?? "png").toLowerCase();
  return { extension, bytes };
}

/** 图片的像素尺寸（浏览器里读；读不出来就退回 4:3）。 */
export async function imageSizeOf(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  try {
    const blob = new Blob([bytes as unknown as BlobPart]);
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    if (size.width > 0 && size.height > 0) return size;
  } catch {
    // 下面给兜底
  }
  return { width: 800, height: 600 };
}

function parser(): DOMParser {
  return new DOMParser();
}

/** `ppt/media/imageN.ext` 里没被占用的下一个编号。 */
function nextMediaName(names: string[], extension: string): string {
  let index = 1;
  const used = new Set(names);
  while (used.has(`ppt/media/image${index}.${extension}`)) index += 1;
  return `ppt/media/image${index}.${extension}`;
}

export interface InsertPictureInput {
  source: ArrayBuffer;
  /** 目标幻灯片部件名（`ppt/slides/slideN.xml`）。 */
  partName: string;
  dataUri: string;
  /** 页面尺寸（EMU）：用来把图片等比放进页面。 */
  pageWidth: number;
  pageHeight: number;
  /** 形状名（不传就自动取"图片 N"）。 */
  name?: string;
}

export interface InsertPictureResult {
  bytes: ArrayBuffer;
  mediaName: string;
  relationshipId: string;
  name: string;
  bounds: { x: number; y: number; width: number; height: number };
}

export async function insertPicture(input: InsertPictureInput): Promise<InsertPictureResult> {
  const zip = await JSZip.loadAsync(input.source.slice(0));
  const { extension, bytes } = decodeImageDataUri(input.dataUri);
  const size = await imageSizeOf(bytes);

  // ① 媒体部件
  const names = Object.keys(zip.files);
  const mediaName = nextMediaName(names, extension);
  zip.file(mediaName, bytes);

  // ② Content_Types：扩展名默认类型（大多数 pptx 已有，缺了才补）
  const contentTypesName = "[Content_Types].xml";
  const contentTypesXml = (await zip.file(contentTypesName)?.async("string")) ?? "";
  if (contentTypesXml && !new RegExp(`Extension="${extension}"`, "i").test(contentTypesXml)) {
    zip.file(
      contentTypesName,
      contentTypesXml.replace(
        /(<Types[^>]*>)/,
        `$1<Default Extension="${extension}" ContentType="image/${extension === "jpeg" ? "jpeg" : extension}"/>`,
      ),
    );
  }

  // ③ 这一页的 .rels：加一条 image 关系（没有 rels 文件就建一个）
  const relsName = `ppt/slides/_rels/${input.partName.split("/").pop() ?? "slide1.xml"}.rels`;
  const relsXml =
    (await zip.file(relsName)?.async("string")) ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}"/>`;
  const relDocument = parser().parseFromString(relsXml, "application/xml");
  const usedIds = new Set(
    Array.from(relDocument.getElementsByTagNameNS(REL_NS, "Relationship")).map(
      (node) => node.getAttribute("Id") ?? "",
    ),
  );
  let relationshipId = "";
  for (let index = 1; index <= usedIds.size + 1; index += 1) {
    const candidate = `rId${index}`;
    if (!usedIds.has(candidate)) {
      relationshipId = candidate;
      break;
    }
  }
  if (!relationshipId) relationshipId = `rId${usedIds.size + 1}`;
  const relationship = relDocument.createElementNS(REL_NS, "Relationship");
  relationship.setAttribute("Id", relationshipId);
  relationship.setAttribute("Type", IMAGE_REL_TYPE);
  relationship.setAttribute("Target", `../media/${mediaName.split("/").pop() ?? mediaName}`);
  relDocument.documentElement.append(relationship);
  zip.file(relsName, new XMLSerializer().serializeToString(relDocument));

  // ④ 幻灯片里插一个 p:pic（放在最上层：spTree 末尾）
  const slideXml = (await zip.file(input.partName)?.async("string")) ?? "";
  const document = parser().parseFromString(slideXml, "application/xml");
  const tree = document.getElementsByTagNameNS(P_NS, "spTree")[0];
  if (!tree) throw new Error("这一页没有 spTree，插不了图片");

  const existingIds = Array.from(tree.getElementsByTagNameNS(P_NS, "cNvPr")).map((node) =>
    Number(node.getAttribute("id") ?? 0),
  );
  const shapeId = (existingIds.length > 0 ? Math.max(...existingIds) : 1) + 1;
  const name = input.name ?? `图片 ${shapeId}`;

  // 等比放进页面：最多占 60% 宽、50% 高，居中
  const maxWidth = Math.round(input.pageWidth * 0.6);
  const maxHeight = Math.round(input.pageHeight * 0.5);
  const ratio = size.width / size.height;
  let width = maxWidth;
  let height = Math.round(width / ratio);
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(height * ratio);
  }
  const bounds = {
    x: Math.round((input.pageWidth - width) / 2),
    y: Math.round((input.pageHeight - height) / 2),
    width,
    height,
  };

  const pic = document.createElementNS(P_NS, "p:pic");
  pic.innerHTML = [
    `<p:nvPicPr xmlns:p="${P_NS}">`,
    `<p:cNvPr id="${shapeId}" name="${name.replace(/"/g, "")}"/>`,
    `<p:cNvPicPr><a:picLocks noChangeAspect="1" xmlns:a="${A_NS}"/></p:cNvPicPr>`,
    `<p:nvPr/>`,
    `</p:nvPicPr>`,
    `<p:blipFill xmlns:p="${P_NS}">`,
    `<a:blip xmlns:a="${A_NS}" xmlns:r="${R_NS}" r:embed="${relationshipId}"/>`,
    `<a:stretch><a:fillRect/></a:stretch>`,
    `</p:blipFill>`,
    `<p:spPr xmlns:p="${P_NS}">`,
    `<a:xfrm xmlns:a="${A_NS}"><a:off x="${bounds.x}" y="${bounds.y}"/><a:ext cx="${bounds.width}" cy="${bounds.height}"/></a:xfrm>`,
    `<a:prstGeom prst="rect" xmlns:a="${A_NS}"><a:avLst/></a:prstGeom>`,
    `</p:spPr>`,
  ].join("");
  tree.append(pic);
  zip.file(input.partName, new XMLSerializer().serializeToString(document));

  const out = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return { bytes: out, mediaName, relationshipId, name, bounds };
}
