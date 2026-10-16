/**
 * 把本次编辑**记成 Word 修订**（`w:ins` / `w:del`），写回导出结果。
 *
 * 语义出处：插件仓 `plugins/office-editor/server/docx_revisions.py` 里已验证过的规则——**公共前后缀 +
 * 最小改动段**（在那份 6000 修订的压测文档上对齐 5990/5990）。这里做段落级移植：
 *   同一段：取新旧文本的公共前缀 P / 公共后缀 S → 中间那段旧文 → `w:del`，新文 → `w:ins`；
 *   整段新增 → 整段包 `w:ins`；整段删除 → 整段包 `w:del`。
 * 接受＝保留 ins、丢弃 del（我们回到"编辑后的样子"）；拒绝＝丢弃 ins、还原 del（回到基线）——
 * 与 Word 的一致口径，也正是审阅卡片/插件所依赖的。
 *
 * 明确不做（写在这里，免得被当成 bug）：段内不做词级 LCS（整段包一层更保守）；表格单元格里的段落
 * 按文档顺序同样处理；批注/脚注等部件的修订不涉及。
 */
import JSZip from "jszip";

export interface TrackedChangeStats {
  inserted: number;
  deleted: number;
  modified: number;
}

export interface TrackedChangeOptions {
  author: string;
  /** ISO 时间戳（`w:date` 要这个格式）。 */
  date: string;
}

interface Paragraph {
  start: number;
  end: number;
  text: string;
}

const PARAGRAPH_PATTERN = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

function paragraphText(paragraphXml: string): string {
  let text = "";
  for (const match of paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
    text += match[1];
  }
  return text;
}

function collectParagraphs(documentXml: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  for (const match of documentXml.matchAll(PARAGRAPH_PATTERN)) {
    const start = match.index ?? 0;
    paragraphs.push({ start, end: start + match[0].length, text: paragraphText(match[0]) });
  }
  return paragraphs;
}

/** 两段文本的相似度：公共前后缀占较长一方的比例（0~1）。 */
function similarity(oldText: string, newText: string): number {
  const longer = Math.max(oldText.length, newText.length);
  if (longer === 0) return 1;
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return (prefix + suffix) / longer;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function run(text: string): string {
  return `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function deletedRun(text: string): string {
  return `<w:r><w:delText xml:space="preserve">${escapeXml(text)}</w:delText></w:r>`;
}

function insertWrapper(text: string, options: TrackedChangeOptions, id: number): string {
  if (!text) return "";
  return `<w:ins w:id="${id}" w:author="${escapeXml(options.author)}" w:date="${options.date}">${run(text)}</w:ins>`;
}

/** 删除整段：文字包 w:del，同时把段落标记也标成删除（`w:pPr/w:rPr/w:del`）——Word 里接受后该段会消失。 */
function deleteWholeParagraph(
  text: string,
  options: TrackedChangeOptions,
  id: number,
  indent: string,
): string {
  const marker = `<w:pPr><w:rPr><w:del w:id="${id}" w:author="${escapeXml(options.author)}" w:date="${options.date}"/></w:rPr></w:pPr>`;
  return `${indent}${marker}<w:del w:id="${id + 1}" w:author="${escapeXml(options.author)}" w:date="${options.date}">${deletedRun(text)}</w:del>`;
}

function deleteWrapper(text: string, options: TrackedChangeOptions, id: number): string {
  if (!text) return "";
  return `<w:del w:id="${id}" w:author="${escapeXml(options.author)}" w:date="${options.date}">${deletedRun(text)}</w:del>`;
}

/** 段落内最小改动：返回包裹后的段落 XML（保留原来的段落属性）。 */
function trackParagraphChange(
  paragraphXml: string,
  oldText: string,
  newText: string,
  options: TrackedChangeOptions,
  nextId: () => number,
): string {
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldText.slice(prefix, oldText.length - suffix);
  const added = newText.slice(prefix, newText.length - suffix);
  const before = oldText.slice(0, prefix);
  const after = suffix > 0 ? oldText.slice(oldText.length - suffix) : "";

  // 段落属性（pPr）与原有 rPr 都保留：只替换 run 部分
  const properties =
    /^<w:p(?:\s[^>]*)?>([\s\S]*?)(?=<w:r[ >]|<w:hyperlink[ >]|<\/w:p>)/.exec(paragraphXml)?.[1] ??
    "";
  const openTag = /^<w:p(?:\s[^>]*)?>/.exec(paragraphXml)?.[0] ?? "<w:p>";
  return `${openTag}${properties}${run(before)}${deleteWrapper(removed, options, nextId())}${insertWrapper(added, options, nextId())}${run(after)}</w:p>`;
}

export interface TrackedChangesResult {
  xml: string;
  stats: TrackedChangeStats;
}

/**
 * 在**编辑后的** document.xml 上标注修订（基线用来对比）。
 * 段落对齐用"公共前缀段 + 公共后缀段"，中间区域按数量对齐：多出来的段算新增、少掉的算删除。
 */
export function trackChangesInDocumentXml(
  baselineXml: string,
  editedXml: string,
  options: TrackedChangeOptions,
): TrackedChangesResult {
  const baseline = collectParagraphs(baselineXml);
  const edited = collectParagraphs(editedXml);
  const stats: TrackedChangeStats = { inserted: 0, deleted: 0, modified: 0 };
  let nextIdValue = 900000;
  const nextId = () => (nextIdValue += 1);

  const textAt = (list: Paragraph[], index: number): string | undefined => list[index]?.text;
  let head = 0;
  while (
    head < baseline.length &&
    head < edited.length &&
    textAt(baseline, head) === textAt(edited, head)
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < baseline.length - head &&
    tail < edited.length - head &&
    textAt(baseline, baseline.length - 1 - tail) === textAt(edited, edited.length - 1 - tail)
  ) {
    tail += 1;
  }

  const baselineMiddle = baseline.slice(head, baseline.length - tail);
  const editedMiddle = edited.slice(head, edited.length - tail);
  const edits: Array<{ start: number; end: number; xml: string }> = [];

  // 中间区域：按位置逐段比对。相似（公共前后缀占比够高）→ 记为"改写"（del 旧 + ins 新）；
  // 不相似 → 当成"删掉这段、另起一段"（审阅卡片里这两类的读法完全不同，别混）。
  const pairCount = Math.min(baselineMiddle.length, editedMiddle.length);
  for (let index = 0; index < pairCount; index += 1) {
    const oldParagraph = baselineMiddle[index];
    const newParagraph = editedMiddle[index];
    if (!oldParagraph || !newParagraph || oldParagraph.text === newParagraph.text) continue;
    const original = editedXml.slice(newParagraph.start, newParagraph.end);
    if (similarity(oldParagraph.text, newParagraph.text) >= 0.3) {
      edits.push({
        start: newParagraph.start,
        end: newParagraph.end,
        xml: trackParagraphChange(original, oldParagraph.text, newParagraph.text, options, nextId),
      });
      stats.modified += 1;
      continue;
    }
    // 不相似：一次替换成"删掉旧段 + 新段整段插入"（**必须是一条编辑**：两条同位置的编辑会互相吃到对方）
    const inner = original.replace(/^<w:p(?:\s[^>]*)?>/, "").replace(/<\/w:p>$/, "");
    edits.push({
      start: newParagraph.start,
      end: newParagraph.end,
      xml:
        `<w:p>${deleteWholeParagraph(oldParagraph.text, options, nextId(), "")}</w:p>` +
        `<w:p><w:ins w:id="${nextId()}" w:author="${escapeXml(options.author)}" w:date="${options.date}">${inner}</w:ins></w:p>`,
    });
    stats.deleted += 1;
    stats.inserted += 1;
  }
  for (let index = pairCount; index < editedMiddle.length; index += 1) {
    const paragraph = editedMiddle[index];
    if (!paragraph) continue;
    const original = editedXml.slice(paragraph.start, paragraph.end);
    const inner = original.replace(/^<w:p(?:\s[^>]*)?>/, "").replace(/<\/w:p>$/, "");
    edits.push({
      start: paragraph.start,
      end: paragraph.end,
      xml: `<w:p><w:ins w:id="${nextId()}" w:author="${escapeXml(options.author)}" w:date="${options.date}">${inner}</w:ins></w:p>`,
    });
    stats.inserted += 1;
  }
  for (let index = pairCount; index < baselineMiddle.length; index += 1) {
    const paragraph = baselineMiddle[index];
    if (!paragraph) continue;
    // 被删除的整段：插到它原来位置之前（用编辑后文档的对应偏移）
    const anchor =
      editedMiddle[pairCount] ?? edited[edited.length - tail] ?? edited[edited.length - 1];
    const offset = anchor ? anchor.start : editedXml.length;
    const inner = editedXml.slice(paragraph.start, paragraph.end);
    void inner;
    edits.push({
      start: offset,
      end: offset,
      xml: `<w:p>${deleteWholeParagraph(paragraph.text, options, nextId(), "")}</w:p>`,
    });
    stats.deleted += 1;
  }

  // 从后往前替换，避免偏移失效
  let out = editedXml;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.xml + out.slice(edit.end);
  }
  return { xml: out, stats };
}

/** zip 层面：把修订写进导出结果的 document.xml。 */
export async function applyTrackedChanges(
  baselineBytes: ArrayBuffer,
  editedBytes: ArrayBuffer,
  options: TrackedChangeOptions,
): Promise<{ bytes: ArrayBuffer; stats: TrackedChangeStats }> {
  const baseline = await JSZip.loadAsync(baselineBytes);
  const edited = await JSZip.loadAsync(editedBytes);
  const baselineXml = await baseline.file("word/document.xml")?.async("string");
  const editedEntry = edited.file("word/document.xml");
  const editedXml = await editedEntry?.async("string");
  if (!baselineXml || !editedXml) throw new Error("docx 缺少 word/document.xml");
  const { xml, stats } = trackChangesInDocumentXml(baselineXml, editedXml, options);
  edited.file("word/document.xml", xml);
  return { bytes: await edited.generateAsync({ type: "arraybuffer" }), stats };
}

/** 接受全部修订后的可见文本（回归检查用：应等于"编辑后的样子"）。 */
export function acceptedText(documentXml: string): string {
  const withoutDeleted = documentXml.replace(/<w:del(?:\s[^>]*)?>[\s\S]*?<\/w:del>/g, "");
  return collectParagraphs(withoutDeleted)
    .map((paragraph) => paragraph.text)
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * 拒绝全部修订后的可见文本（应等于**基线**）。
 *
 * 拒绝＝丢弃 `w:ins` 的内容、把 `w:del` 的 `w:delText` 还原成正文。整段删除的情况用基线里
 * 对应段落的文本补回来（我们标注整段删除时把原文写进了 `w:delText`，所以这里直接取即可）。
 */
export function rejectedText(documentXml: string, baselineXml: string): string {
  const withoutInserted = documentXml.replace(/<w:ins(?:\s[^>]*)?>[\s\S]*?<\/w:ins>/g, "");
  const restored = withoutInserted.replace(
    /<w:del(?:\s[^>]*)?>([\s\S]*?)<\/w:del>/g,
    (_match, inner: string) =>
      `<w:r><w:t xml:space="preserve">${[...String(inner).matchAll(/<w:delText(?:\s[^>]*)?>([\s\S]*?)<\/w:delText>/g)].map((entry) => entry[1]).join("")}</w:t></w:r>`,
  );
  // 段级顺序：标注后的文档里，被删段落仍以 <w:p> 形式存在，所以直接取文本即可
  const lines = collectParagraphs(restored)
    .map((paragraph) => paragraph.text)
    .filter((text) => text.length > 0);
  void baselineXml;
  return lines.join("\n");
}
