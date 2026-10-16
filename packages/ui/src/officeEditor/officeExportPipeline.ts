/**
 * 保存前的**导出后处理流水线**：导出的 docx 依次经过
 *   ① 修订模式：把本次改动与基线对比，写成 `w:ins`/`w:del`（"改动记为修订"）；
 *   ② 修订/批注写回：未被编辑过的段落换回原件（`w:ins`/`w:del`/`w:commentReference` 一个不丢）；
 *   ③ 页眉页脚回填：源有则原样拷回、源没有则撤掉插件新加的那套。
 * 每一步都返回一句给用户看的话（状态栏），避免"保存完了但不知道文档变成什么样"。
 */
import { preserveHeaderFooter } from "./docxHeaderFooter.js";
import { restoreRevisions, type RevisionPreservationState } from "./docxRevisions.js";
import { applyTrackedChanges } from "./docxTrackChanges.js";

export interface ComposeExportInput {
  /** 插件导出的字节。 */
  exported: ArrayBuffer;
  /** 打开时的文件字节（C2 的对比基线、页眉页脚的来源）。 */
  source: ArrayBuffer | null;
  revisionPreservation: RevisionPreservationState;
  trackChanges: { enabled: boolean; author: string; date: string };
}

export interface ComposeExportResult {
  bytes: ArrayBuffer;
  notes: string[];
}

export async function composeExportedDocx(input: ComposeExportInput): Promise<ComposeExportResult> {
  const notes: string[] = [];

  // ① 修订模式
  let bytes = input.exported;
  if (input.trackChanges.enabled && input.source) {
    const tracked = await applyTrackedChanges(input.source, bytes, {
      author: input.trackChanges.author,
      date: input.trackChanges.date,
    });
    bytes = tracked.bytes;
    const stats = tracked.stats;
    if (stats.inserted || stats.deleted || stats.modified) {
      notes.push(
        `已记为修订（插入 ${stats.inserted} 段 / 删除 ${stats.deleted} 段 / 修改 ${stats.modified} 段）`,
      );
    }
  }

  // ② 修订/批注写回
  const revisions = await restoreRevisions(bytes, input.revisionPreservation);
  bytes = revisions.bytes;
  if (revisions.restored) {
    notes.push(
      `保留原修订/批注 ${revisions.restored} 段${
        revisions.edited ? `（${revisions.edited} 段被编辑过，其原有标记按你的改动处理）` : ""
      }`,
    );
  }

  // ③ 页眉页脚
  if (input.source) {
    const restored = await preserveHeaderFooter(input.source, bytes);
    bytes = restored.bytes;
    if (restored.note) notes.push(restored.note);
  }

  return { bytes, notes };
}
