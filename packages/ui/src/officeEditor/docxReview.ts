/**
 * 审阅（对标 Word 的接受/拒绝）：枚举修订、逐条或全部处理。
 *
 * 与 docxRevisions.ts 的分工：那边管"怎么显示、怎么保住原件"，这边管"用户按下接受/拒绝之后文档怎么变"。
 * 语义逐条对齐 Word：接受插入＝拆壳保留文字；接受删除＝文字真的删掉；拒绝插入＝插入内容消失；
 * 拒绝删除＝被删文字**还原为正文**（`w:delText` → `w:t`，否则 Word 仍把它当被删文字）。
 */
import JSZip from "jszip";
import { PARAGRAPH_PATTERN, REVISION_COLORS } from "./docxRevisions.js";

export type RevisionKind = "insert" | "delete";

/** 文档里的一处修订（＝一个 `w:ins`/`w:del` 元素，与 Word 的"每处改动一条"同粒度）。 */
export interface RevisionItem {
  /** 全局序号（0 基），用于"上一条/下一条"。 */
  index: number;
  kind: RevisionKind;
  text: string;
  author: string;
  /** 所在段落序号（0 基）。 */
  paragraph: number;
}

export type RevisionAction = "accept" | "reject";

/** 枚举全部修订（按文档顺序）。 */
export function listRevisions(documentXml: string): RevisionItem[] {
  const items: RevisionItem[] = [];
  let paragraph = 0;
  for (const match of documentXml.matchAll(PARAGRAPH_PATTERN)) {
    const paragraphXml = match[0];
    for (const revision of paragraphXml.matchAll(
      /<w:(ins|del|moveTo|moveFrom)(?:\s[^>]*)?>([\s\S]*?)<\/w:\1>/g,
    )) {
      const tag = revision[1];
      const inner = revision[2] ?? "";
      const author = /w:author="([^"]*)"/.exec(revision[0])?.[1] ?? "";
      let text = "";
      for (const run of inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) text += run[1];
      for (const run of inner.matchAll(/<w:delText(?:\s[^>]*)?>([\s\S]*?)<\/w:delText>/g))
        text += run[1];
      items.push({
        index: items.length,
        kind: tag === "ins" || tag === "moveTo" ? "insert" : "delete",
        text,
        author,
        paragraph,
      });
    }
    paragraph += 1;
  }
  return items;
}

export interface ResolveRevisionsOptions {
  action: RevisionAction;
  /** 只处理这一条（按 `listRevisions` 的序号）；省略＝处理全部。 */
  targetIndex?: number;
}

export interface ResolveRevisionsResult {
  xml: string;
  /** 本次处理了几条。 */
  resolved: number;
  /** 处理完还剩几条（逐条处理时用得上）。 */
  remaining: RevisionItem[];
  /** 处理掉的都是哪些（状态栏用）。 */
  handled: RevisionItem[];
}

/**
 * 接受/拒绝修订（Word 的语义）：
 *   - 接受插入 → 拆掉 `w:ins` 外壳（文字成为正文，并去掉我们加的标记格式）；
 *   - 拒绝插入 → 整段删掉插入的文字；
 *   - 接受删除 → 把 `w:del` 里的文字真的删掉；
 *   - 拒绝删除 → 拆掉 `w:del` 外壳（被删文字恢复为正文，去掉标记格式）。
 */
export function resolveRevisions(
  documentXml: string,
  options: ResolveRevisionsOptions,
): ResolveRevisionsResult {
  const targets = listRevisions(documentXml);
  const wants = (item: RevisionItem) =>
    options.targetIndex === undefined ? true : item.index === options.targetIndex;
  const handled = targets.filter(wants);
  if (handled.length === 0)
    return { xml: documentXml, resolved: 0, remaining: targets, handled: [] };

  const kinds = new Set(handled.map((item) => item.kind));
  const accept = options.action === "accept";
  const unwrapKinds = new Set<RevisionKind>();
  const dropKinds = new Set<RevisionKind>();
  if (accept) {
    unwrapKinds.add("insert");
    dropKinds.add("delete");
  } else {
    dropKinds.add("insert");
    unwrapKinds.add("delete");
  }
  void kinds;

  const stripMarker = (xml: string) =>
    xml
      .replace(`<w:u w:val="single"/>`, "")
      .replace(new RegExp(`<w:color w:val="${REVISION_COLORS.insert}"/>`, "g"), "")
      .replace(`<w:strike/>`, "")
      .replace(new RegExp(`<w:color w:val="${REVISION_COLORS.delete}"/>`, "g"), "");

  let seen = 0;
  const xml = documentXml.replace(
    /<w:(ins|del|moveTo|moveFrom)(?:\s[^>]*)?>[\s\S]*?<\/w:\1>/g,
    (whole) => {
      const item = targets[seen];
      seen += 1;
      if (!item || !wants(item)) return whole;
      if (unwrapKinds.has(item.kind)) {
        // 拆壳保留文字。**拒绝删除**时还要把 w:delText 还原成 w:t，否则 Word 仍把它当成被删的文字。
        const inner = whole
          .replace(/^<w:(?:ins|moveTo|del|moveFrom)(?:\s[^>]*)?>/, "")
          .replace(/<\/w:(?:ins|moveTo|del|moveFrom)>$/, "")
          .replace(/<w:delText(\s[^>]*)?>/g, "<w:t$1>")
          .replace(/<\/w:delText>/g, "</w:t>");
        return stripMarker(inner);
      }
      if (dropKinds.has(item.kind)) return "";
      return whole;
    },
  );
  return {
    xml,
    resolved: handled.length,
    remaining: targets.filter((item) => !wants(item)),
    handled,
  };
}

/** zip 层面：按动作处理修订（逐条或全部）。 */
export async function resolveRevisionsInDocx(
  bytes: ArrayBuffer,
  options: ResolveRevisionsOptions,
): Promise<{ bytes: ArrayBuffer } & Omit<ResolveRevisionsResult, "xml">> {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry) return { bytes, resolved: 0, remaining: [], handled: [] };
  const result = resolveRevisions(await entry.async("string"), options);
  zip.file("word/document.xml", result.xml);
  return {
    bytes: await zip.generateAsync({ type: "arraybuffer" }),
    resolved: result.resolved,
    remaining: result.remaining,
    handled: result.handled,
  };
}
