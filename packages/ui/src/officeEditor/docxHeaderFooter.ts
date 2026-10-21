/**
 * 导出后**把页眉/页脚还给原文档**。
 *
 * 为什么需要：canvas-editor 的 docx 插件导出时会**自己生成一套页眉页脚**（footer1.xml 里带 PAGE 域），
 * 于是"原文档没有页脚"的情况保存后凭空多出一个页码页脚；"原文档有页眉页脚（含公司 logo）"的情况
 * 则会被换成插件那套。我们的编辑器不编辑页眉页脚，所以正确处理是**原样保留**。
 *
 * 做法（zip 层面，不碰正文语义）：
 *   - 源文档**没有**页眉页脚 → 从导出里删掉这些部件、去掉 sectPr 的引用、清理 rels 与 Content_Types 覆盖；
 *   - 源文档**有**页眉页脚 → 把源部件（连同各自的 .rels：logo 等图片就在里面）原样拷回导出包，
 *     导出的 sectPr 引用关系（rId → header1.xml/footer1.xml）保持不变，于是指向的就是原内容。
 */
import JSZip from "jszip";

const HEADER_FOOTER_PART = /^word\/(?:header|footer)\d*\.xml$/;
const HEADER_FOOTER_RELS = /^word\/_rels\/(?:header|footer)\d*\.xml\.rels$/;

export interface HeaderFooterResult {
  bytes: ArrayBuffer;
  /** 做了什么（写进保存后的状态栏，让用户知道页眉页脚的去向）。 */
  note: string;
}

export async function preserveHeaderFooter(
  sourceBytes: ArrayBuffer,
  exportedBytes: ArrayBuffer,
): Promise<HeaderFooterResult> {
  const source = await JSZip.loadAsync(sourceBytes);
  const out = await JSZip.loadAsync(exportedBytes);

  const sourceParts = Object.keys(source.files).filter(
    (name) => HEADER_FOOTER_PART.test(name) || HEADER_FOOTER_RELS.test(name),
  );

  if (sourceParts.length === 0) {
    // 源文档本来没有页眉页脚：把插件新加的那套撤掉，避免"保存后多出一个页码页脚"
    const removed = Object.keys(out.files).filter(
      (name) => HEADER_FOOTER_PART.test(name) || HEADER_FOOTER_RELS.test(name),
    );
    if (removed.length === 0) return { bytes: exportedBytes, note: "" };
    for (const name of removed) out.remove(name);
    await rewriteDocumentXml(out, (xml) =>
      xml.replace(/<w:(?:header|footer)Reference[^>]*\/>/g, ""),
    );
    await rewriteRels(out, (xml) =>
      xml.replace(/<Relationship[^>]*Type="[^"]*\/(?:header|footer)"[^>]*\/>/g, ""),
    );
    await rewriteContentTypes(out, (xml) =>
      xml.replace(/<Override[^>]*PartName="\/word\/(?:header|footer)\d*\.xml"[^>]*\/>/g, ""),
    );
    return { bytes: await out.generateAsync({ type: "arraybuffer" }), note: "已去掉插件默认页脚" };
  }

  // 源文档有页眉页脚：原样拷回（包含 .rels，logo 之类的图片才不会丢）
  const parts: string[] = [];
  for (const name of sourceParts) {
    const content = await source.file(name)?.async("uint8array");
    if (content) {
      out.file(name, content);
      parts.push(name.replace(/^word\/(?:_rels\/)?/, ""));
    }
  }
  // 导出可能没有对应的 Content_Types 覆盖（新部件类型），按源文档补齐
  const sourceTypes = (await source.file("[Content_Types].xml")?.async("string")) ?? "";
  const overrides =
    sourceTypes.match(/<Override[^>]*\/word\/(?:header|footer)\d*\.xml"[^>]*\/>/g) ?? [];
  if (overrides.length > 0) {
    await rewriteContentTypes(out, (xml) => {
      const missing = overrides.filter((entry) => {
        const partName = /PartName="([^"]+)"/.exec(entry)?.[1];
        return partName ? !xml.includes(`PartName="${partName}"`) : false;
      });
      if (missing.length === 0) return xml;
      return xml.replace("</Types>", `${missing.join("")}</Types>`);
    });
  }
  return {
    bytes: await out.generateAsync({ type: "arraybuffer" }),
    note: `已保留原页眉页脚（${parts.join("、")}）`,
  };
}

async function rewriteDocumentXml(zip: JSZip, transform: (xml: string) => string): Promise<void> {
  const entry = zip.file("word/document.xml");
  if (!entry) return;
  zip.file("word/document.xml", transform(await entry.async("string")));
}

async function rewriteRels(zip: JSZip, transform: (xml: string) => string): Promise<void> {
  const entry = zip.file("word/_rels/document.xml.rels");
  if (!entry) return;
  zip.file("word/_rels/document.xml.rels", transform(await entry.async("string")));
}

async function rewriteContentTypes(zip: JSZip, transform: (xml: string) => string): Promise<void> {
  const entry = zip.file("[Content_Types].xml");
  if (!entry) return;
  zip.file("[Content_Types].xml", transform(await entry.async("string")));
}
