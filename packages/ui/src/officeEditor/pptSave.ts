/**
 * PPTX 的**保存流水线**：把当前状态写成新字节 → 产物校验 → 写盘（带版本比对与 sibling 备份）。
 *
 * 单独成文件的原因：编辑位那个 hook 要守 400 行，而"保存"是它里面最大的一块；
 * 这一块也确实是独立的一步（输入：源字节 + 基线 + 当前三份映射；输出：校验结果与写盘回执）。
 * 校验不过**一律不写盘**——那是保真的最后一道闸门。
 */
import type { OfficeEditorFilePort } from "./contract.js";
import { bytesToBase64 } from "./binary.js";
import { writeDeckSlides } from "./pptText.js";
import { validatePptxCandidate } from "./pptxValidate.js";

export interface SavePptxInput {
  fileService: OfficeEditorFilePort;
  path: string;
  /** 当前源 zip（可能已经过幻灯片/图片这类"包级补丁"）。 */
  source: ArrayBuffer;
  /** 打开（或上次保存）时的各页 XML。 */
  baseline: Map<string, string>;
  /** 当前各页 XML（含未保存改动）。 */
  current: Map<string, string>;
  /** 保存时的版本比对（有的服务端不给 mtime，那就只比大小）。 */
  revision: { size: number; mtimeMs: number } | null;
}

export type SavePptxResult =
  | {
      ok: true;
      bytes: ArrayBuffer;
      changedSlides: string[];
      backupName: string;
      revision: { size: number; mtimeMs: number } | null;
      megabytes: number;
    }
  | { ok: false; kind: "validation"; issues: string[] }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "error"; message: string };

export async function savePptxDocument(input: SavePptxInput): Promise<SavePptxResult> {
  try {
    const written = await writeDeckSlides({
      source: input.source,
      baseline: input.baseline,
      current: input.current,
    });
    const validation = await validatePptxCandidate(written.bytes, input.source, {
      editedSlides: written.changedSlides,
    });
    if (!validation.ok) {
      return { ok: false, kind: "validation", issues: validation.issues.map((i) => i.message) };
    }
    const bytes = new Uint8Array(written.bytes);
    const result = await input.fileService.writeBinaryFile({
      path: input.path,
      dataBase64: bytesToBase64(bytes),
      ...(input.revision ? { expectedRevision: input.revision } : {}),
      backup: "sibling",
    });
    return {
      ok: true,
      bytes: written.bytes,
      changedSlides: written.changedSlides,
      backupName: result.backup ? (result.backup.split("/").pop() ?? "") : "",
      revision: result.revision,
      megabytes: result.bytes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("revision mismatch")
      ? { ok: false, kind: "conflict" }
      : { ok: false, kind: "error", message };
  }
}
