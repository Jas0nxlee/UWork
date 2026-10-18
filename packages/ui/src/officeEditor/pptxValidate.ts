/**
 * pptx 保存前的**产物校验**（与 docx/xlsx 同款底线）。
 *
 * 我们承诺的是"只改文字、其余部件逐字节保留"，所以这里把承诺写成可执行的检查：
 *   ① 产物能当 zip 读、`ppt/presentation.xml` 与 `[Content_Types].xml` 都在；
 *   ② 幻灯片数量与源文件一致；
 *   ③ **除被编辑的幻灯片外，所有部件的内容哈希与源文件一致**（这条是"保真"的硬证据）；
 *   ④ 每张幻灯片都是能解析的 XML；
 *   ⑤ 文字总量没塌（掉两成以上就判为"把内容改没了"）。
 * 不过就不写盘——宁可让用户看到明确失败，也不能写一份打不开的 deck。
 */
import JSZip from "jszip";

export interface PptxValidationIssue {
  kind:
    | "invalid-pptx"
    | "missing-part"
    | "slide-count"
    | "part-modified"
    | "invalid-xml"
    | "text-lost";
  message: string;
}

export interface PptxValidationResult {
  ok: boolean;
  issues: PptxValidationIssue[];
  slides: number;
  textLength: number;
}

interface ZipParts {
  names: string[];
  contents: Map<string, Uint8Array>;
}

async function readParts(bytes: ArrayBuffer): Promise<ZipParts | null> {
  try {
    const zip = await JSZip.loadAsync(bytes.slice(0));
    const contents = new Map<string, Uint8Array>();
    const names: string[] = [];
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      names.push(name);
      contents.set(name, await entry.async("uint8array"));
    }
    return { names, contents };
  } catch {
    return null;
  }
}

function textLengthOf(xml: string): number {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const nodes = Array.from(
    document.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "t"),
  );
  return nodes.reduce((total, node) => total + (node.textContent ?? "").length, 0);
}

const SLIDE_PART = /^ppt\/slides\/slide\d+\.xml$/;

export async function validatePptxCandidate(
  candidate: ArrayBuffer,
  source: ArrayBuffer | null,
  options: { editedSlides?: string[] } = {},
): Promise<PptxValidationResult> {
  const issues: PptxValidationIssue[] = [];
  const parts = await readParts(candidate);
  if (!parts) {
    return {
      ok: false,
      issues: [{ kind: "invalid-pptx", message: "产物打不开（不是有效的 pptx）" }],
      slides: 0,
      textLength: 0,
    };
  }
  for (const required of ["ppt/presentation.xml", "[Content_Types].xml"]) {
    if (!parts.contents.has(required)) {
      issues.push({ kind: "missing-part", message: `产物里缺 ${required}` });
    }
  }
  const slideNames = parts.names.filter((name) => SLIDE_PART.test(name));
  const edited = new Set(options.editedSlides ?? []);

  let textLength = 0;
  for (const name of slideNames) {
    const xml = new TextDecoder().decode(parts.contents.get(name) ?? new Uint8Array());
    const document = new DOMParser().parseFromString(xml, "application/xml");
    if (document.getElementsByTagName("parsererror").length > 0) {
      issues.push({ kind: "invalid-xml", message: `${name} 不是能解析的 XML` });
      continue;
    }
    textLength += textLengthOf(xml);
  }

  if (source) {
    const before = await readParts(source);
    if (before) {
      const beforeSlides = before.names.filter((name) => SLIDE_PART.test(name));
      if (beforeSlides.length !== slideNames.length) {
        issues.push({
          kind: "slide-count",
          message: `幻灯片数量从 ${beforeSlides.length} 变成 ${slideNames.length}`,
        });
      }
      // 保真的硬证据：**没被编辑的部件，内容必须逐字节一致**（幻灯片只放过被编辑过的那几张）
      const modified: string[] = [];
      for (const name of before.names) {
        const then = before.contents.get(name);
        if (!then) continue;
        const now = parts.contents.get(name);
        if (!now) {
          modified.push(`${name}（丢了）`);
          continue;
        }
        if (SLIDE_PART.test(name) && edited.has(name)) continue;
        if (!sameBytes(then, now)) modified.push(name);
      }
      if (modified.length > 0) {
        issues.push({
          kind: "part-modified",
          message: `这些没被编辑的部件变了：${modified.slice(0, 4).join("、")}${
            modified.length > 4 ? `（共 ${modified.length} 个）` : ""
          }`,
        });
      }
      let beforeText = 0;
      for (const name of beforeSlides) {
        beforeText += textLengthOf(new TextDecoder().decode(before.contents.get(name)));
      }
      if (beforeText > 0 && textLength < beforeText * 0.8) {
        issues.push({
          kind: "text-lost",
          message: `文字量从 ${beforeText} 掉到 ${textLength}`,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues, slides: slideNames.length, textLength };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
