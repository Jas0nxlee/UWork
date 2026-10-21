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
  /** 批注清单（作者/时间/内容/所在段落），供审阅窗格与"上一/下一批注"用。 */
  comments: DocumentComment[];
  paragraphs: ParagraphPreservation[];
  summary: { inserted: number; deleted: number; comments: number };
  /** 每处批注的编号与锚点文字，供正文标记与（后续的）气泡列表使用。 */
  commentMarks: Array<{ index: number; paragraph: number; around: string }>;
}

export const PARAGRAPH_PATTERN = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

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

/**
 * 把一份 document.xml 改写成"Word 标记视图"，并记下每段的原件。
 * 只有含修订/批注的段落会被改写；其它段落原样返回。
 */
export function buildRevisionView(
  documentXml: string,
  commentContents: Map<string, { author: string; date: string; text: string }> = new Map(),
): RevisionView {
  const paragraphs: ParagraphPreservation[] = [];
  const comments: DocumentComment[] = [];
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

    // 批注：Word 的锚定方式是 commentRangeStart/End（被批注的正文），锚点文字加浅底纹，
    // 内容与作者来自 comments.xml，交互（定位/删除）用引擎的 group（官方 demo 同一套）。
    let commentsInParagraph = 0;
    const rangeIds = [...paragraphXml.matchAll(/<w:commentRangeStart[^>]*w:id="([^"]*)"/g)].map(
      (match) => match[1],
    );
    for (const id of rangeIds) {
      commentIndex += 1;
      commentsInParagraph += 1;
      const start = next.indexOf(`w:commentRangeStart w:id="${id}"`);
      const end = next.indexOf(`w:commentRangeEnd w:id="${id}"`);
      const anchorText =
        start >= 0 && end > start
          ? paragraphText(next.slice(next.indexOf(">", start) + 1, next.lastIndexOf("<", end)))
          : "";
      const content = commentContents.get(id ?? "");
      comments.push({
        index: commentIndex,
        id: id ?? "",
        author: content?.author ?? "",
        date: content?.date ?? "",
        text: content?.text ?? "",
        paragraph: current,
        anchorText,
      });
      commentMarks.push({
        index: commentIndex,
        paragraph: current,
        around: anchorText.slice(0, 20),
      });
    }
    if (rangeIds.length > 0) {
      // 给锚点范围里的 run 加浅底纹（Word 的批注底色），让它一眼看得出被批注过
      next = next.replace(
        /(<w:commentRangeStart[^>]*>[\s\S]*?<w:commentRangeEnd[^>]*>)/g,
        (block) =>
          block.replace(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g, (run) =>
            addRunProperties(run, `<w:shd w:val="clear" w:color="auto" w:fill="FFF7D6"/>`),
          ),
      );
    }

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

  return { xml: rewritten, paragraphs, summary, commentMarks, comments };
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

export interface DocumentComment {
  /** 文档里的第几条批注（1 基，供卡片标题与"上一条/下一条"）。 */
  index: number;
  id: string;
  author: string;
  date: string;
  text: string;
  /** 所在段落序号（0 基）。 */
  paragraph: number;
  /**
   * 被批注的正文（`w:commentRangeStart` → `w:commentRangeEnd` 之间的文字）。
   * 官方 demo 的口径是"选中一段文字 → `executeSetGroup()` 建组 → 宿主记卡片"，
   * 所以我们导入后按这段文字在引擎里建组，用 `executeLocationGroup` 定位——不自己发明标记。
   */
  anchorText: string;
}

export interface RevisionPreservationState {
  paragraphs: ParagraphPreservation[];
  comments: DocumentComment[];
}

/** 解析 `word/comments.xml`：批注 id → 作者/时间/内容（Word 的批注窗格就读这个）。 */
export async function readComments(zip: {
  file: (path: string) => { async: (type: "string") => Promise<string> } | null;
}): Promise<Map<string, { author: string; date: string; text: string }>> {
  const entry = zip.file("word/comments.xml");
  if (!entry) return new Map();
  const xml = await entry.async("string");
  const map = new Map<string, { author: string; date: string; text: string }>();
  for (const match of xml.matchAll(/<w:comment(?:\s[^>]*)?>([\s\S]*?)<\/w:comment>/g)) {
    const whole = match[0];
    const id = /w:id="([^"]*)"/.exec(whole)?.[1] ?? "";
    const author = /w:author="([^"]*)"/.exec(whole)?.[1] ?? "";
    const date = /w:date="([^"]*)"/.exec(whole)?.[1] ?? "";
    let text = "";
    for (const run of (match[1] ?? "").matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g))
      text += run[1];
    map.set(id, { author, date, text });
  }
  return map;
}

/** 导入前：改写 document.xml 为"标记视图"，并把原件留在 preservation 里。 */
export async function applyRevisionView(bytes: ArrayBuffer): Promise<{
  bytes: ArrayBuffer;
  preservation: RevisionPreservationState;
  summary: RevisionView["summary"];
  comments: DocumentComment[];
}> {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry)
    return {
      bytes,
      preservation: { paragraphs: [], comments: [] },
      summary: { inserted: 0, deleted: 0, comments: 0 },
      comments: [],
    };
  // 批注内容在 word/comments.xml：正文里的 [n] 标记要能对应回作者与内容（审阅窗格与"上一/下一批注"）
  const commentContents = await readComments(zip);
  const view = buildRevisionView(await entry.async("string"), commentContents);
  if (view.paragraphs.length === 0) {
    return {
      bytes,
      preservation: { paragraphs: [], comments: [] },
      summary: view.summary,
      comments: [],
    };
  }
  zip.file("word/document.xml", view.xml);
  return {
    bytes: await zip.generateAsync({ type: "arraybuffer" }),
    preservation: { paragraphs: view.paragraphs, comments: view.comments },
    summary: view.summary,
    comments: view.comments,
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

/**
 * 删除批注标记（Word 的"删除批注"）：去掉 `w:commentRangeStart/End` 与对应 run 里的 `w:commentReference`，
 * **正文一个字不动**。返回值同时给"改了什么"，供状态栏与回归检查用。
 */
export function removeCommentMarkup(
  documentXml: string,
  ids: Iterable<string>,
): { xml: string; removed: number } {
  const targets = new Set(ids);
  let removed = 0;
  let out = documentXml;
  for (const id of targets) {
    const before = out;
    out = out
      .replace(new RegExp(`<w:commentRangeStart[^>]*w:id="${id}"[^>]*/>`, "g"), "")
      .replace(new RegExp(`<w:commentRangeEnd[^>]*w:id="${id}"[^>]*/>`, "g"), "")
      // 引用所在的那个 run 整个去掉（它只承载锚点，没有文字）
      .replace(
        new RegExp(
          `<w:r(?:\\s[^>]*)?>(?:(?!</w:r>)[\\s\\S])*?<w:commentReference[^>]*w:id="${id}"[^>]*/>(?:(?!</w:r>)[\\s\\S])*?</w:r>`,
          "g",
        ),
        "",
      );
    if (out !== before) removed += 1;
  }
  return { xml: out, removed };
}

/** zip 层面删除批注标记（保存后文件里真的没有这条批注）。 */
export async function removeCommentAnchorsInDocx(
  bytes: ArrayBuffer,
  ids: Iterable<string>,
): Promise<{ bytes: ArrayBuffer; removed: number }> {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry) return { bytes, removed: 0 };
  const result = removeCommentMarkup(await entry.async("string"), ids);
  if (result.removed === 0) return { bytes, removed: 0 };
  zip.file("word/document.xml", result.xml);
  return { bytes: await zip.generateAsync({ type: "arraybuffer" }), removed: result.removed };
}

/** 从"段落原件"里也去掉这些批注（否则保存时 restoreRevisions 会把锚点又写回去）。 */
export function stripCommentsFromPreservation(
  preservation: RevisionPreservationState,
  ids: Iterable<string>,
): RevisionPreservationState {
  const targets = new Set(ids);
  return {
    comments: preservation.comments.filter((comment) => !targets.has(comment.id)),
    paragraphs: preservation.paragraphs.map((paragraph) => {
      const hasTarget = preservation.comments.some(
        (comment) => targets.has(comment.id) && comment.paragraph === paragraph.index,
      );
      if (!hasTarget) return paragraph;
      const stripped = removeCommentMarkup(paragraph.originalXml, targets).xml;
      return { ...paragraph, originalXml: stripped, comments: 0 };
    }),
  };
}
