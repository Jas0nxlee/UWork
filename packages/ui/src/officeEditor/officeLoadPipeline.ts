/**
 * 打开文档前的**准备**（与 officeExportPipeline 对称）：护栏预检 → 修订/批注的正文内标记视图。
 *
 * 三种结果，调用方按结果决定"能不能编辑、要不要先问用户"：
 *   - `blocked`：真会丢内容（脚注/尾注）→ 列清单让用户决定；
 *   - `tooLarge`：解压后的 document.xml 超上限（真正的体量口径）；
 *   - `ready`：可以导入（带着改写后的字节、修订/批注清单与保留的原件）。
 */
import {
  applyRevisionView,
  type DocumentComment,
  type RevisionPreservationState,
} from "./docxRevisions.js";
import {
  preprocessDocx,
  summarizeFindings,
  type DocxFindings,
  type DocxPreflightResult,
} from "./docxPreflight.js";

/** document.xml 的上限：真正的体量口径（实测 191 KB 的 docx 解出 2.35 MB，约 12 倍）。 */
export const MAX_DOCUMENT_XML_BYTES = 4 * 1024 * 1024;

export interface PreparedDocument {
  status: "ready";
  bytes: ArrayBuffer;
  /** 归一化后、尚未做修订标记视图的字节：审阅动作在这份字节上做。 */
  normalizedBytes: ArrayBuffer;
  preservation: RevisionPreservationState;
  comments: DocumentComment[];
  summary: { inserted: number; deleted: number; comments: number };
}

export type PrepareDocumentResult =
  | PreparedDocument
  | { status: "blocked"; preflight: DocxPreflightResult; notices: string[] }
  | { status: "tooLarge"; findings: DocxFindings };

export async function prepareDocumentForImport(
  raw: ArrayBuffer,
  options: { skipGuard?: boolean } = {},
): Promise<PrepareDocumentResult> {
  let normalizedBytes = raw;
  if (!options.skipGuard) {
    const preflight = await preprocessDocx(raw);
    normalizedBytes = preflight.bytes;
    if (preflight.findings.documentXmlBytes > MAX_DOCUMENT_XML_BYTES) {
      return { status: "tooLarge", findings: preflight.findings };
    }
    const notices = summarizeFindings(preflight.findings);
    if (notices.length > 0) return { status: "blocked", preflight, notices };
  }
  const view = await applyRevisionView(normalizedBytes);
  return {
    status: "ready",
    bytes: view.bytes,
    normalizedBytes,
    preservation: view.preservation,
    comments: view.comments,
    summary: view.summary,
  };
}
