/**
 * 修订与批注的**正文内显示**（对标 Word 的"标记显示"）与**保存时原样写回**。
 *
 * 背景（实测）：canvas-editor 的 docx 插件**完全不认识** `w:ins`/`w:del`/`w:commentReference`——
 * 导入时把插入的文字直接丢掉、导出时也不写修订标记。所以"像 Office 那样显示/处理修订"只能我们自己建：
 *
 *  1) 导入前把修订**改写成正文字**，但保留 Word 的样子：
 *     - 插入 → 拆掉 `w:ins` 外壳，给这些 run **加**下划线 + 蓝色（不覆盖原有格式）；
 *     - 删除 → 拆掉 `w:del` 外壳、`w:delText` 改成 `w:t`，加删除线 + 红色（Word 就是这么显示被删文字的）；
 *     - 批注锚点 → 换成上标标记 `[1]`（Word 是页边批注气泡，这里先用正文标记，气泡后续做）。
 *  2) 保存时按段落**原样写回**：段落文字没被编辑过（displayText 一致）就把**原始 XML**（含 `w:ins`/`w:del`/
 *     `w:commentReference`）整段换回去——于是修订与批注一个都不会丢，也不会被"静默接受"。
 *     段落被用户编辑过时，保留用户的版本（其原有修订由 C2 的 diff 机制记为新的修订）。
 */
import JSZip from "jszip";

/** Word 的修订配色：插入蓝、删除红、批注橙（正文是白纸，颜色要够深）。 */
export const REVISION_COLORS = {
  insert: "1A73E8",
  delete: "D93025",
  comment: "B45309",
} as const;

export interface ParagraphPreservation {
  /** 段落在文档里的序号（0 基）。 */
  index: number;
  /** 原始段落 XML（含 `w:ins`/`w:del`/`w:commentReference`）。 */
  originalXml: string;
  /** 改写后的纯文字：保存时用它判断"这一段有没有被用户改过"。 */
  displayText: string;
  inserted: number;
  deleted: number;
  comments: number;
}

export interface RevisionView {
  xml: string;
  paragraphs: ParagraphPreservation[];
  summary: { inserted: number; deleted: number; comments: number };
  /** 每处批注的编号与锚点文字，供正文标记与（后续的）气泡列表使用。 */
  commentMarks: Array<{ index: number; paragraph: number; around: string }>;
}

const PARAGRAPH_PATTERN = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

function paragraphText(paragraphXml: string): string {
  let text = "";
  for (const match of paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
    text += match[1];
  }
  return text;
}

/** 往 run 的 `w:rPr` 里**追加**属性（没有 rPr 就建一个，已有 rPr 就把新属性插到最前）。 */
function addRunProperties(runXml: string, properties: string): string {
  if (/<w:rPr>/.test(runXml)) {
    return runXml.replace("<w:rPr>", `<w:rPr>${properties}`);
  }
  return runXml.replace(/^(<w:r(?:\s[^>]*)?>)/, `$1<w:rPr>${properties}</w:rPr>`);
}

function styleInsertedXml(inner: string): string {
  return inner.replace(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g, (run) =>
    addRunProperties(run, `<w:u w:val="single"/><w:color w:val="${REVISION_COLORS.insert}"/>`),
  );
}

function styleDeletedXml(inner: string): string {
  return inner
    .replace(/<w:delText(\s[^>]*)?>/g, "<w:t$1>")
    .replace(/<\/w:delText>/g, "</w:t>")
    .replace(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g, (run) =>
      addRunProperties(run, `<w:strike/><w:color w:val="${REVISION_COLORS.delete}"/>`),
    );
}

/** 取 run 里第一个 `w:t` 的文字（批注锚点前后要显示一点上下文）。 */
function runText(runXml: string): string {
  return [...runXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join("");
}

/**
 * 把一份 document.xml 改写成"Word 标记视图"，并记下每段的原件。
 * 只有含修订/批注的段落会被改写；其它段落原样返回。
 */
export function buildRevisionView(documentXml: string): RevisionView {
  const paragraphs: ParagraphPreservation[] = [];
  const commentMarks: RevisionView["commentMarks"] = [];
  let commentIndex = 0;
  const summary = { inserted: 0, deleted: 0, comments: 0 };
  let paragraphIndex = 0;

  const rewritten = documentXml.replace(PARAGRAPH_PATTERN, (paragraphXml) => {
    const hasRevisions =
      /<w:ins[ >]/.test(paragraphXml) ||
      /<w:(?:del|moveFrom|moveTo)[ >]/.test(paragraphXml) ||
      /<w:commentReference[ >]/.test(paragraphXml);
    const current = paragraphIndex;
    paragraphIndex += 1;
    if (!hasRevisions) return paragraphXml;

    const inserted = (paragraphXml.match(/<w:ins[ >]/g) ?? []).length;
    const deleted = (paragraphXml.match(/<w:(?:del|moveFrom)[ >]/g) ?? []).length;

    let next = paragraphXml
      // 插入：拆壳 + 下划线着色
      .replace(/<w:ins(?:\s[^>]*)?>([\s\S]*?)<\/w:ins>/g, (_m, inner: string) =>
        styleInsertedXml(String(inner)),
      )
      .replace(/<w:moveTo(?:\s[^>]*)?>([\s\S]*?)<\/w:moveTo>/g, (_m, inner: string) =>
        styleInsertedXml(String(inner)),
      )
      // 删除：拆壳 + 删除线着红（保留文字，Word 也这么显示）
      .replace(/<w:del(?:\s[^>]*)?>([\s\S]*?)<\/w:del>/g, (_m, inner: string) =>
        styleDeletedXml(String(inner)),
      )
      .replace(/<w:moveFrom(?:\s[^>]*)?>([\s\S]*?)<\/w:moveFrom>/g, (_m, inner: string) =>
        styleDeletedXml(String(inner)),
      );

    // 批注：run 里的 commentReference → 上标编号标记
    let commentsInParagraph = 0;
    next = next.replace(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g, (run) => {
      if (!/<w:commentReference[ >]/.test(run)) return run;
      commentIndex += 1;
      commentsInParagraph += 1;
      const around = runText(run).slice(0, 20);
      commentMarks.push({ index: commentIndex, paragraph: current, around });
      return `<w:r><w:rPr><w:vertAlign w:val="superscript"/><w:color w:val="${REVISION_COLORS.comment}"/></w:rPr><w:t>[${commentIndex}]</w:t></w:r>`;
    });

    summary.inserted += inserted;
    summary.deleted += deleted;
    summary.comments += commentsInParagraph;
    paragraphs.push({
      index: current,
      originalXml: paragraphXml,
      displayText: paragraphText(next),
      inserted,
      deleted,
      comments: commentsInParagraph,
    });
    return next;
  });

  return { xml: rewritten, paragraphs, summary, commentMarks };
}

/**
 * 保存时写回：段落文字与导入时一致 → 整段换回**原始 XML**（修订/批注原样保留）。
 * 返回写回了几段、以及有多少段因为被编辑过而没能保留原标记。
 */
export function restoreOriginalParagraphs(
  exportedXml: string,
  paragraphs: ParagraphPreservation[],
): { xml: string; restored: number; edited: number } {
  const byIndex = new Map(paragraphs.map((entry) => [entry.index, entry]));
  let index = 0;
  let restored = 0;
  let edited = 0;
  const xml = exportedXml.replace(PARAGRAPH_PATTERN, (paragraphXml) => {
    const entry = byIndex.get(index);
    index += 1;
    if (!entry) return paragraphXml;
    if (paragraphText(paragraphXml) === entry.displayText) {
      restored += 1;
      return entry.originalXml;
    }
    edited += 1;
    return paragraphXml;
  });
  return { xml, restored, edited };
}

export interface RevisionPreservationState {
  paragraphs: ParagraphPreservation[];
}

/** 导入前：改写 document.xml 为"标记视图"，并把原件留在 preservation 里。 */
export async function applyRevisionView(bytes: ArrayBuffer): Promise<{
  bytes: ArrayBuffer;
  preservation: RevisionPreservationState;
  summary: RevisionView["summary"];
}> {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry)
    return {
      bytes,
      preservation: { paragraphs: [] },
      summary: { inserted: 0, deleted: 0, comments: 0 },
    };
  const view = buildRevisionView(await entry.async("string"));
  if (view.paragraphs.length === 0) {
    return { bytes, preservation: { paragraphs: [] }, summary: view.summary };
  }
  zip.file("word/document.xml", view.xml);
  return {
    bytes: await zip.generateAsync({ type: "arraybuffer" }),
    preservation: { paragraphs: view.paragraphs },
    summary: view.summary,
  };
}

/** 保存时：把未被编辑的段落换回原件（修订/批注不丢、不被静默接受）。 */
export async function restoreRevisions(
  bytes: ArrayBuffer,
  preservation: RevisionPreservationState,
): Promise<{ bytes: ArrayBuffer; restored: number; edited: number }> {
  if (preservation.paragraphs.length === 0) return { bytes, restored: 0, edited: 0 };
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry) return { bytes, restored: 0, edited: 0 };
  const result = restoreOriginalParagraphs(await entry.async("string"), preservation.paragraphs);
  zip.file("word/document.xml", result.xml);
  return {
    bytes: await zip.generateAsync({ type: "arraybuffer" }),
    restored: result.restored,
    edited: result.edited,
  };
}
