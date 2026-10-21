/**
 * PPTX 编辑位的**状态合成**：把"改过的 XML"与"界面上的文字改动"合成一份当前状态。
 *
 * 两个用途共用它，所以口径必须只有一份（保存时写盘的那份 == 画布渲染的那份）：
 *   ① 保存：`writeDeckSlides({source, baseline, current})` → 只替换改过的页 → 产物校验 → 写盘；
 *   ② 画布：渲染器要的是整份文件，所以每改一次就重算一份字节喂给它。
 */
import { patchTxBody, writeDeckSlides } from "./pptText.js";

/** 读 zip 里某个部件（幻灯片级操作之后用它把新的页读回来）。 */
export async function readSlidePart(bytes: ArrayBuffer, partName: string): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes.slice(0));
  return (await zip.file(partName)?.async("string")) ?? "";
}

/** key 形如 `ppt/slides/slide1.xml#2`（`usePptxDocument` 的 editKey）。 */
export type PptxEditMap = Map<string, string[]>;

/** 当前状态 = 各页 XML 再叠上界面里的文字改动。 */
export function composeCurrentSlides(
  current: Map<string, string>,
  edits: PptxEditMap,
): Map<string, string> {
  const composed = new Map(current);
  for (const [key, lines] of edits) {
    const [partName, indexText] = key.split("#");
    if (!partName || indexText === undefined) continue;
    const xml = composed.get(partName);
    if (xml === undefined) continue;
    composed.set(partName, patchTxBody(xml, Number(indexText), lines));
  }
  return composed;
}

/**
 * 画布要渲染的字节：只替换改过的页，其余部件逐字节保留。
 * 失败返回 null（调用方保留上一帧）——画布是辅助，不能反过来挡住编辑。
 */
export async function buildPreviewBytes(input: {
  source: ArrayBuffer;
  baseline: Map<string, string>;
  current: Map<string, string>;
}): Promise<ArrayBuffer | null> {
  try {
    const written = await writeDeckSlides({
      source: input.source.slice(0),
      baseline: input.baseline,
      current: input.current,
    });
    return written.bytes;
  } catch {
    return null;
  }
}
