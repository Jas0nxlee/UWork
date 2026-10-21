/**
 * 写回前的**产物校验**（轻量版：只用 JSZip + DOMParser，不引入 Office/LibreOffice）。
 *
 * 为什么要它：保存路径上我们自己做了不少"外科手术"（归一化、修订/批注标记视图与回写、页眉页脚回填、
 * 修订模式落 `w:ins`/`w:del`）——任何一步把包结构改坏，用户拿到的是一个**打不开的 docx**，
 * 而我们现在写完就报"已保存"，没有任何校验。PilotDeck 的 `deliver` 会拒绝"结构不安全或不可读"的产物，
 * 这里照同样的原则做，只是不依赖外部程序：
 *
 *   ① 能当 zip 解开，且必备部件齐全（`[Content_Types].xml`、`_rels/.rels`、`word/document.xml`）；
 *   ② 每个 `.xml`/`.rels` 部件**能被 XML 解析器解析**（截断/标签不闭合会立刻暴露）；
 *   ③ `r:id`/`r:embed` 引用的关系在 `document.xml.rels` 里存在（回填/删除部件时最容易断的就是它）；
 *   ④ **正文没有塌陷**：与源文档比较，接受视图下的文字量不应比源少 20% 以上
 *      （这正是"修订被静默丢掉"那类事故的特征——那时我们丢掉了 2.7 万字符却一路"保存成功"）。
 */
import JSZip from "jszip";

export interface DocxValidationIssue {
  code:
    | "not-a-zip"
    | "missing-part"
    | "invalid-xml"
    | "dangling-relationship"
    | "content-collapsed";
  message: string;
}

export interface DocxValidationResult {
  ok: boolean;
  issues: DocxValidationIssue[];
  /** 正文文字量（校验过程顺手算出来的，便于排查）。 */
  textLength: number;
}

/** 接受修订后的可见文字（丢 `w:del`、保留 `w:ins`），用于"内容有没有塌陷"的比较。 */
function visibleText(documentXml: string): string {
  const withoutDeleted = documentXml.replace(/<w:del(?:\s[^>]*)?>[\s\S]*?<\/w:del>/g, "");
  let text = "";
  for (const match of withoutDeleted.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g))
    text += match[1];
  return text;
}

function relationshipIds(xml: string): Set<string> {
  const ids = new Set<string>();
  for (const match of xml.matchAll(/<Relationship[^>]*Id="([^"]+)"/g)) ids.add(match[1] ?? "");
  return ids;
}

/** 正文里用到的关系 id（`r:id` / `r:embed` / `r:link`）。 */
function referencedRelationshipIds(documentXml: string): Set<string> {
  const ids = new Set<string>();
  for (const match of documentXml.matchAll(/r:(?:id|embed|link)="([^"]+)"/g))
    ids.add(match[1] ?? "");
  return ids;
}

const REQUIRED_PARTS = ["[Content_Types].xml", "_rels/.rels", "word/document.xml"];

function parseXmlOrIssue(name: string, content: string, issues: DocxValidationIssue[]): boolean {
  // 浏览器/渲染进程有 DOMParser；node 侧（回归检查）走一个宽松的标签配对兜底
  if (typeof DOMParser !== "undefined") {
    const parsed = new DOMParser().parseFromString(content, "application/xml");
    if (parsed.getElementsByTagName("parsererror").length > 0) {
      issues.push({ code: "invalid-xml", message: `${name} 不是合法 XML（标签未闭合或被截断）` });
      return false;
    }
    return true;
  }
  const open = (content.match(/<[a-zA-Z]/g) ?? []).length;
  const close = (content.match(/<\//g) ?? []).length + (content.match(/\/>/g) ?? []).length;
  if (close < open) {
    issues.push({ code: "invalid-xml", message: `${name} 疑似被截断（开标签多于闭标签）` });
    return false;
  }
  return true;
}

/**
 * 校验一份"准备写回"的 docx。
 * @param candidate 即将写回的字节
 * @param source 打开时的原始字节（用于内容量对比；没有就跳过第 ④ 项）
 */
export async function validateDocxCandidate(
  candidate: ArrayBuffer,
  source?: ArrayBuffer | null,
): Promise<DocxValidationResult> {
  const issues: DocxValidationIssue[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(candidate);
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "not-a-zip", message: `产物不是合法的 docx 包：${String(error)}` }],
      textLength: 0,
    };
  }

  for (const part of REQUIRED_PARTS) {
    if (!zip.file(part)) issues.push({ code: "missing-part", message: `缺少必备部件 ${part}` });
  }
  if (issues.length > 0) return { ok: false, issues, textLength: 0 };

  const documentXml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  // ① XML 合法性：所有部件都过一遍（数量有限，代价可接受）
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/\.(xml|rels)$/.test(name)) continue;
    const content = await entry.async("string");
    parseXmlOrIssue(name, content, issues);
  }
  // ② 关系完整性：正文引用到的 r:id 必须在 rels 里
  const relsEntry = zip.file("word/_rels/document.xml.rels");
  const rels = relsEntry ? relationshipIds(await relsEntry.async("string")) : new Set<string>();
  const dangling = [...referencedRelationshipIds(documentXml)].filter((id) => !rels.has(id));
  if (dangling.length > 0) {
    issues.push({
      code: "dangling-relationship",
      message: `正文引用了不存在的关��（${dangling.slice(0, 5).join("、")}${dangling.length > 5 ? "…" : ""}）——Word 会报文件损坏`,
    });
  }
  // ③ 内容塌陷：与源文档比，接受视图下的文字量不应大幅减少
  const textLength = visibleText(documentXml).length;
  if (source) {
    try {
      const sourceZip = await JSZip.loadAsync(source);
      const sourceXml = (await sourceZip.file("word/document.xml")?.async("string")) ?? "";
      const sourceLength = visibleText(sourceXml).length;
      if (sourceLength > 0 && textLength < sourceLength * 0.8) {
        issues.push({
          code: "content-collapsed",
          message: `正文文字比源文件少 ${Math.round((1 - textLength / sourceLength) * 100)}%（${sourceLength} → ${textLength} 字符）——像是内容被吞掉了，已拒绝写入`,
        });
      }
    } catch {
      // 源文件读不出来就跳过这项（不因此阻断保存）
    }
  }
  return { ok: issues.length === 0, issues, textLength };
}
