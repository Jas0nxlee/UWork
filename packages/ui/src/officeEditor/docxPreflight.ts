/**
 * docx **导入前预处理与护栏**。
 *
 * 为什么必须有这一层：canvas-editor 的 docx 插件（第三方 dist）对一批 Word 特性**直接丢内容**，
 * 实测（见回归检查）：
 *   - `w:ins` 里的文字、整段 `w:ins` → 导入即消失（Word 里它们是"已插入的正文"）；
 *   - `w:hyperlink` 的文字、`m:oMath` 公式文字 → 消失；
 *   - `w:commentReference` 批注锚点、`w:footnoteReference` 脚注 → 导出（保存）时消失；
 *   - `w:numPr` 编号、`w:sdt` 控件外壳、`w:fldSimple` 域 → 结构降级（文字还在）。
 * 这些如果不管，用户"打开一份待审阅的文档、随手改一下、保存"就会**静默毁内容**。
 *
 * 所以：能无损归一化的先归一化（保留文字、去掉插件不认的标记），
 * 剩下的（脚注内容这类真的保不住）如实列给用户，让他在知情后决定是否继续编辑。
 */
import JSZip from "jszip";

export interface DocxFindings {
  /** 修订：插入 / 删除 / 格式修订（`*PrChange`）。 */
  revisions: { inserted: number; deleted: number; formatChanges: number };
  comments: number;
  footnotes: number;
  hyperlinks: number;
  formulas: number;
  contentControls: number;
  fields: number;
  numbering: number;
  hasHeaderFooter: boolean;
  /** 解压后的 document.xml 字节数：真正决定"能不能编辑"的体量口径（文件大小会小十几倍）。 */
  documentXmlBytes: number;
}

export function emptyFindings(): DocxFindings {
  return {
    revisions: { inserted: 0, deleted: 0, formatChanges: 0 },
    comments: 0,
    footnotes: 0,
    hyperlinks: 0,
    formulas: 0,
    contentControls: 0,
    fields: 0,
    numbering: 0,
    hasHeaderFooter: false,
    documentXmlBytes: 0,
  };
}

function countOf(xml: string, pattern: RegExp): number {
  return (xml.match(pattern) ?? []).length;
}

export function analyzeDocumentXml(
  xml: string,
  options: { hasHeaderFooter?: boolean } = {},
): DocxFindings {
  return {
    revisions: {
      inserted: countOf(xml, /<w:ins[ >]/g),
      deleted: countOf(xml, /<w:(del|moveFrom)[ >]/g),
      formatChanges: countOf(xml, /<w:\w+PrChange[ >]/g),
    },
    comments: countOf(xml, /<w:commentReference[ >]/g),
    footnotes: countOf(xml, /<w:(footnote|endnote)Reference[ >]/g),
    hyperlinks: countOf(xml, /<w:hyperlink[ >]/g),
    formulas: countOf(xml, /<m:oMath[ >]/g),
    contentControls: countOf(xml, /<w:sdt[ >]/g),
    fields: countOf(xml, /<w:fldSimple[ >]/g),
    numbering: countOf(xml, /<w:numPr[ >]/g),
    hasHeaderFooter: options.hasHeaderFooter ?? false,
    documentXmlBytes: new TextEncoder().encode(xml).length,
  };
}

/** 这些特性会被归一化：文字留下、标记去掉（Word 里相当于"接受修订"）。 */
export interface NormalizeResult {
  xml: string;
  changes: string[];
}

/**
 * 归一化：只做**保住文字**的变换。
 *
 * 逐条对应实测结论：
 *   - `w:ins` / `w:moveTo` → 拆壳保留内容（Word 的"接受插入"）；`w:del` / `w:moveFrom` → 整体删掉（"接受删除"）；
 *   - `*PrChange` → 删掉（它保存的是旧格式，删掉即"保留当前格式"）；
 *   - `w:hyperlink` → 拆壳保留文字（链接地址不写回，如实告知）；
 *   - `m:oMath` → 用它的文字（`m:t`）替换，公式排版丢失但内容不丢；
 *   - `w:sdt` → 拆壳保留 `w:sdtContent`（控件语义丢失，文字保留）；
 *   - `w:commentReference` → 去掉锚点（批注内容在 comments.xml，插件不写回，如实告知）。
 */
export function normalizeDocumentXml(xml: string): NormalizeResult {
  const changes: string[] = [];
  let out = xml;

  const unwrap = (tag: string): number => {
    let count = 0;
    for (;;) {
      const match = new RegExp(`<${tag}(?:\\s[^>]*)?>`).exec(out);
      if (!match) break;
      const end = out.indexOf(`</${tag}>`, match.index);
      if (end < 0) break;
      out =
        out.slice(0, match.index) +
        out.slice(match.index + match[0].length, end) +
        out.slice(end + `</${tag}>`.length);
      count += 1;
    }
    return count;
  };

  // 修订与批注**不在这里动**：由 docxRevisions 按 Word 的样子显示并在保存时原样写回。
  const links = countOf(out, /<w:hyperlink[ >]/g);
  unwrap("w:hyperlink");
  if (links > 0) changes.push(`${links} 处超链接变成普通文字（链接地址不会写回）`);

  const formulas = countOf(out, /<m:oMath[ >]/g);
  if (formulas > 0) {
    out = out.replace(/<m:oMath(?:\s[^>]*)?>[\s\S]*?<\/m:oMath>/g, (block) => {
      const text = [...block.matchAll(/<m:t(?:\s[^>]*)?>([\s\S]*?)<\/m:t>/g)]
        .map((m) => m[1])
        .join("");
      return text ? `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>` : "";
    });
    changes.push(`${formulas} 处公式变成文字（排版丢失，内容保留）`);
  }

  const controls = countOf(out, /<w:sdt[ >]/g);
  for (;;) {
    const start = out.search(/<w:sdt[\s>]/);
    if (start < 0) break;
    const contentStart = out.indexOf("<w:sdtContent", start);
    const end = out.indexOf("</w:sdt>", start);
    if (contentStart < 0 || end < 0) break;
    const openEnd = out.indexOf(">", contentStart) + 1;
    const contentEnd = out.indexOf("</w:sdtContent>", openEnd);
    if (contentEnd < 0 || contentEnd > end) break;
    out = out.slice(0, start) + out.slice(openEnd, contentEnd) + out.slice(end + "</w:sdt>".length);
  }
  if (controls > 0) changes.push(`${controls} 处内容控件变成普通文字`);

  return { xml: out, changes };
}

export interface DocxPreflightResult {
  /** 归一化后的字节（交给引擎导入）。 */
  bytes: ArrayBuffer;
  findings: DocxFindings;
  changes: string[];
}

/**
 * 解 zip → 统计特性 → 归一化 document.xml（只做"保住文字"的变换；修订/批注交给 docxRevisions）→ 重新打包。
 */
export async function preprocessDocx(bytes: ArrayBuffer): Promise<DocxPreflightResult> {
  const zip = await JSZip.loadAsync(bytes);
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) throw new Error("不是有效的 docx：缺少 word/document.xml");
  const original = await documentEntry.async("string");
  const hasHeaderFooter =
    Boolean(zip.file("word/header1.xml")) || Boolean(zip.file("word/footer1.xml"));
  const findings = analyzeDocumentXml(original, { hasHeaderFooter });
  const { xml, changes } = normalizeDocumentXml(original);
  zip.file("word/document.xml", xml);
  return { bytes: await zip.generateAsync({ type: "arraybuffer" }), findings, changes };
}

/** 把 findings 总结成给用户看的一行（用于护栏横幅）。 */
export function summarizeFindings(findings: DocxFindings): string[] {
  const lines: string[] = [];
  const { inserted, deleted, formatChanges } = findings.revisions;
  if (inserted || deleted || formatChanges) {
    lines.push(
      `修订 ${inserted} 处插入 / ${deleted} 处删除 / ${formatChanges} 处格式（会按"接受"处理，修订标记不再写回）`,
    );
  }
  if (findings.comments) lines.push(`批注 ${findings.comments} 处（锚点会去掉，批注内容不会写回）`);
  if (findings.footnotes)
    lines.push(`脚注/尾注 ${findings.footnotes} 处（脚注内容不会写回——这些内容会丢）`);
  if (findings.hyperlinks) lines.push(`超链接 ${findings.hyperlinks} 处（变成普通文字）`);
  if (findings.formulas) lines.push(`公式 ${findings.formulas} 处（变成文字，排版丢失）`);
  if (findings.contentControls)
    lines.push(`内容控件 ${findings.contentControls} 处（变成普通文字）`);
  if (findings.fields) lines.push(`域 ${findings.fields} 处（保留当前显示值，域不再自动更新）`);
  if (findings.numbering) lines.push(`${findings.numbering} 处编号列表（编号变成普通段落）`);
  return lines;
}
