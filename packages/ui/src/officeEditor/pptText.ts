/**
 * PPTX 的**文字层读写**（幻灯片里那些 `a:t` 文本节点）。
 *
 * 为什么只做文字层：没有可用的 OSS pptx 编辑器（PPTist 是 AGPL、不能随企业包分发，见
 * specs/office-editors-triad.md），所以这里的定位是"**改字**而且不碰别的"——
 * 写回只在源 zip 里替换被编辑过的那几张 `ppt/slides/slideN.xml`，其余部件**逐字节保留**
 * （图片、母版、版式、动画、备注、批注一个字节都不动）。这与 Word/Excel 那边的"差分写回"是同一套思路。
 *
 * 模型：**按 `a:txBody` 编号**（文档序），每个 txBody 是一段可编辑文本（段落＝行）。
 * 这样表格单元格（`a:tc` 里也有 txBody）、占位符、普通文本框都能编辑，不用逐个形状类型写分支。
 * 标题/正文这种分栏关系不在这里判断——那是版式的事，改了也不会丢。
 *
 * 已知取舍（写进界面提示）：一行文字的**分段样式**（同一段里几种字体/颜色）在改动那一行时会被
 * 折叠成"首个 run 的样式"；`a:br`（段内换行）按行处理；页码等 `a:fld` 域**不参与编辑也不被破坏**。
 */
import JSZip from "jszip";

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export interface PptxTextBlock {
  /** 在幻灯片里第几个 `a:txBody`（文档序，0 基）。 */
  index: number;
  /** 形状名（`p:cNvPr@name`）或"表格单元格"这类兜底描述，给界面标身份用。 */
  label: string;
  /** 段落文本（一行一段）。 */
  lines: string[];
}

export interface PptxSlide {
  /** 源 zip 里的部件名，如 `ppt/slides/slide2.xml`。 */
  partName: string;
  /** 幻灯片序号（放映顺序，1 基）。 */
  number: number;
  blocks: PptxTextBlock[];
}

export interface PptxDeck {
  slides: PptxSlide[];
  /** 幻灯片部件的字节与解析结果（保存时的基线与差分来源）。 */
  sourceXml: Map<string, string>;
}

function parser(): DOMParser {
  return new DOMParser();
}

/** 一个 `a:p` 的可见文字（run 的文本顺序拼接；`a:br` 当换行，`a:fld` 不参与）。 */
function paragraphText(paragraph: Element): string {
  let text = "";
  for (const child of Array.from(paragraph.children)) {
    if (child.namespaceURI !== A_NS) continue;
    if (child.localName === "r") {
      // 一个 run 里可以有**多个 a:t**（PowerPoint 会这样拆），全部拼起来
      for (const t of Array.from(child.getElementsByTagNameNS(A_NS, "t"))) {
        text += t.textContent ?? "";
      }
    } else if (child.localName === "br") {
      text += "\n";
    }
  }
  return text;
}

/** `a:txBody` → 段落文本数组（`a:br` 造成的段内换行也拆成行）。 */
function blockLines(txBody: Element): string[] {
  const paragraphs = Array.from(txBody.children).filter(
    (child) => child.namespaceURI === A_NS && child.localName === "p",
  );
  const lines = paragraphs.flatMap((paragraph) => {
    const parts = paragraphText(paragraph).split("\n");
    // 段尾的 a:br 会切出一个空尾巴——那不是用户要编辑的空行，去掉
    if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
    return parts;
  });
  return lines.length > 0 ? lines : [""];
}

function blockLabel(txBody: Element): string {
  let node: Element | null = txBody;
  while (node) {
    if (node.namespaceURI === P_NS && node.localName === "sp") {
      const name = node.getElementsByTagNameNS(P_NS, "cNvPr")[0]?.getAttribute("name");
      return name && name.length > 0 ? name : "文本框";
    }
    if (node.namespaceURI === P_NS && node.localName === "graphicFrame") {
      return node.getElementsByTagNameNS(A_NS, "tbl")[0] ? "表格" : "图形";
    }
    node = node.parentElement;
  }
  return "文本块";
}

/**
 * 幻灯片里的文本块：**`txBody` 有两个命名空间**——形状里是 `p:txBody`（PresentationML），
 * 表格单元格里是 `a:txBody`（DrawingML）。只认 a: 的话表格进得来、正文框全丢（实测）。
 */
function textBodies(document: Document): Element[] {
  return Array.from(document.getElementsByTagNameNS("*", "txBody"));
}

/** 解析一张幻灯片里的所有文本块（形状与表格单元格都算）。 */
export function readSlideText(xml: string): PptxTextBlock[] {
  const document = parser().parseFromString(xml, "application/xml");
  const bodies = textBodies(document);
  return bodies.map((body, index) => ({
    index,
    label: blockLabel(body),
    lines: blockLines(body),
  }));
}

/** "ppt/slides/slideN.xml" 的排序键：按数字排，不按字典序（否则 slide10 会排在 slide2 前面）。 */
function slideOrder(partName: string): number {
  const match = /slide(\d+)\.xml$/.exec(partName);
  return match ? Number(match[1]) : 0;
}

/** 从 zip 里读出所有幻灯片部件（按源文件里的部件名排序，与放映顺序可能不同）。 */
export async function readDeckSlides(bytes: ArrayBuffer): Promise<PptxDeck> {
  const zip = await JSZip.loadAsync(bytes.slice(0));
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideOrder(a) - slideOrder(b));
  const sourceXml = new Map<string, string>();
  const slides: PptxSlide[] = [];
  for (const [position, name] of names.entries()) {
    const xml = (await zip.file(name)?.async("string")) ?? "";
    sourceXml.set(name, xml);
    slides.push({ partName: name, number: position + 1, blocks: readSlideText(xml) });
  }
  return { slides, sourceXml };
}

function clone(element: Element): Element {
  return element.cloneNode(true) as Element;
}

/** 把一段文字写进 `a:p`：首个 run 承载全文，其余 run 的文本清空（保留它们的样式），没有 run 就造一个。 */
function writeParagraphText(document: Document, paragraph: Element, text: string): void {
  const runs = Array.from(paragraph.children).filter(
    (child) => child.namespaceURI === A_NS && child.localName === "r",
  );
  let first = runs[0];
  if (!first) {
    first = document.createElementNS(A_NS, "a:r");
    // 段落级默认样式（a:pPr/a:defRPr）在的话，新 run 继承它，尽量不"变得没样式"
    const defRunProperties = paragraph
      .getElementsByTagNameNS(A_NS, "pPr")[0]
      ?.getElementsByTagNameNS(A_NS, "defRPr")[0];
    if (defRunProperties) first.append(clone(defRunProperties));
    paragraph.append(first);
  }
  const setText = (run: Element, value: string): void => {
    const nodes = Array.from(run.children).filter(
      (child) => child.namespaceURI === A_NS && child.localName === "t",
    );
    const [firstNode, ...extra] = nodes;
    const target = firstNode ?? document.createElementNS(A_NS, "a:t");
    if (!firstNode) run.append(target);
    target.textContent = value;
    // 同一个 run 里多余的 a:t 直接去掉：留着会让"改后的文字"比用户输入的多出几个字（实测踩过）
    for (const node of extra) node.remove();
  };
  setText(first, text);
  for (const run of runs.slice(1)) setText(run, "");
}

/**
 * 用新的段落文本替换某个 `a:txBody` 的内容。
 *
 * 段落数变化时：多出来的行**克隆首段**（沿用它的 `a:pPr` 与首个 run 的样式），少掉的行删掉。
 * 这是"改字"语义下最可预测的做法——新增的行会跟这一块文字原本的排版走，而不是变成默认字体。
 */
export function patchTxBody(xml: string, blockIndex: number, lines: string[]): string {
  const document = parser().parseFromString(xml, "application/xml");
  const bodies = textBodies(document);
  const body = bodies[blockIndex];
  if (!body || lines.length === 0) return xml;

  const paragraphs = Array.from(body.children).filter(
    (child) => child.namespaceURI === A_NS && child.localName === "p",
  );
  const template = paragraphs[0];
  if (!template) return xml;
  const cloneTemplate = (): Element => clone(template);

  for (const [lineIndex, line] of lines.entries()) {
    const paragraph = paragraphs[lineIndex] ?? cloneTemplate();
    if (!paragraphs[lineIndex]) body.append(paragraph);
    // 段落里的 a:br 会让"一行"变成多行：改字时统一改成一个段落一行，先清掉 br
    for (const br of Array.from(paragraph.children).filter(
      (child) => child.namespaceURI === A_NS && child.localName === "br",
    )) {
      br.remove();
    }
    writeParagraphText(document, paragraph, line);
  }
  for (const paragraph of paragraphs.slice(lines.length)) paragraph.remove();

  return new XMLSerializer().serializeToString(document);
}

/** 把改动写回 zip：**只替换被编辑的幻灯片部件**，其余条目逐字节不动。 */
export async function writeDeckSlides(input: {
  source: ArrayBuffer;
  baseline: Map<string, string>;
  current: Map<string, string>;
}): Promise<{ bytes: ArrayBuffer; changedSlides: string[] }> {
  const zip = await JSZip.loadAsync(input.source);
  const changedSlides: string[] = [];
  for (const [partName, xml] of input.current) {
    if (input.baseline.get(partName) === xml) continue;
    zip.file(partName, xml);
    changedSlides.push(partName);
  }
  const bytes = await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  });
  return { bytes, changedSlides };
}

/** 幻灯片数（校验用）。 */
export function countSlides(bytes: ArrayBuffer): Promise<number> {
  return JSZip.loadAsync(bytes).then(
    (zip) =>
      Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length,
  );
}

export const PPTX_NAMESPACES = { A_NS, P_NS, REL_NS };
