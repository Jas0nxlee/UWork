/**
 * 两种"插入"的**纯入口**：插表格（改一页 XML）与插图片（改整份包）。
 *
 * 单独成文件的理由：编辑位那个 hook 要守 400 行；而这里也确实只是"把参数摆成写入侧要的形状"，
 * 不掺任何状态。
 */
import { insertPicture } from "./pptPicture.js";
import { insertTable } from "./pptTableInsert.js";

/** 插表格：只动这一页的 XML。 */
export function patchTableXml(
  xml: string,
  rows: number,
  cols: number,
  pageWidth: number,
  pageHeight: number,
): string {
  return insertTable(xml, { rows, cols, pageWidth, pageHeight }).xml;
}

/** 插图片：新增媒体部件 + 这一页 rels + `p:pic`，所以换的是整份包的字节。 */
export async function patchPictureBytes(
  source: ArrayBuffer,
  input: { partName: string; dataUri: string; pageWidth: number; pageHeight: number },
): Promise<ArrayBuffer> {
  const result = await insertPicture({ source, ...input });
  return result.bytes;
}
