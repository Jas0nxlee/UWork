/**
 * 打开演示文稿时的**准入判定**（与 Word/Excel 编辑位同口径）。
 *
 * 三件事，全部在动文档之前做完：
 *   ① 远端工作区要能写回（RPC 没有能力清单，所以拿"必然版本不匹配的写入"探——见 fileWriteSupport）；
 *   ② 体积上限（pptx 是压缩包，60 MB 的 deck 解出来常常十几倍）；
 *   ③ 读字节 + 记录 revision（保存时的版本比对用它拒绝"边改边被别的程序改"）。
 *
 * 单独成文件的原因：编辑位的文件要守 400 行；这块也确实是"打开门之前的检查"，与编辑逻辑无关。
 */
import type { IFileService } from "@zcode/services";
import { base64ToArrayBuffer } from "./binary.js";
import { probeWriteSupport } from "./fileWriteSupport.js";

export interface PptxOpenChecks {
  /** 应用内编辑的体积上限。 */
  maxBytes: number;
  fileService: IFileService;
  path: string;
  remote?: boolean | undefined;
}

export type PptxOpenResult =
  | {
      ok: true;
      raw: ArrayBuffer;
      /** 保存时做版本比对（有的服务端不给 mtime，那就只比大小）。 */
      revision: { size: number; mtimeMs: number } | null;
    }
  | { ok: false; blocked?: string; reason: string };

export async function openPptxDocumentForEdit(input: PptxOpenChecks): Promise<PptxOpenResult> {
  const [preview, fileStat] = await Promise.all([
    input.fileService.readBinaryPreview({ path: input.path }),
    input.fileService.stat({ path: input.path }),
  ]);
  const revision =
    typeof fileStat.mtimeMs === "number"
      ? { size: preview.totalBytes, mtimeMs: fileStat.mtimeMs }
      : null;

  if (input.remote) {
    const probe = await probeWriteSupport(input.fileService, input.path);
    if (!probe.supported) {
      const reason = probe.reason ?? "服务端不支持写回";
      return { ok: false, blocked: reason, reason: `远端工作区不支持应用内编辑：${reason}` };
    }
  }
  if (preview.totalBytes > input.maxBytes) {
    const mb = Math.round(preview.totalBytes / 1048576);
    return {
      ok: false,
      reason: `演示文稿过大（${mb} MB），不在应用内编辑：请用只读预览。`,
    };
  }
  return { ok: true, raw: base64ToArrayBuffer(preview.dataBase64), revision };
}
