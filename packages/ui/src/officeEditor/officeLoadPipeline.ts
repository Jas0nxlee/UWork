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

/** 取 docx 里 document.xml 的文本（审阅清单按原始标记枚举）。 */
export async function documentXmlOf(bytes: ArrayBuffer): Promise<string> {
  const { default: JSZip } = await import("jszip");
  return (await (await JSZip.loadAsync(bytes)).file("word/document.xml")?.async("string")) ?? "";
}

/** 解析超过这个时间就明确提示卡顿（实测：6000 段 957ms / 20000 段 4.4s）。 */
export const SLOW_PARSE_MS = 3000;
/** 应用内原地编辑的体积上限（docx 文件字节）。 */
export const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;

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

/**
 * 把字节交给引擎导入，并回报解析耗时（超过阈值就如实提示"会很卡"，而不是让用户以为卡是 bug）。
 */
export async function importDocxIntoEditor(input: {
  editor: { command: Record<string, unknown> };
  bytes: ArrayBuffer;
  label: string;
  setStatus: (message: string) => void;
  onLoaded?: () => void;
}): Promise<void> {
  const { editor, bytes, label, setStatus } = input;
  setStatus(`解析文档（${label}）…`);
  const startedAt = performance.now();
  await (
    editor.command.executeImportDocx as (payload: { arrayBuffer: ArrayBuffer }) => Promise<void>
  )({
    arrayBuffer: bytes,
  });
  const elapsedMs = Math.round(performance.now() - startedAt);
  input.onLoaded?.();
  // 实测（headless Chromium，canvas-editor）：500 段 76ms / 2000 段 266ms / 6000 段 957ms / 20000 段 4.4s
  const slowHint =
    elapsedMs > SLOW_PARSE_MS
      ? `（文档很大，编辑会明显卡顿：${Math.round(elapsedMs / 1000)}s 解析。建议改用只读预览 + 卡片审阅。）`
      : "";
  setStatus(
    `已载入 ${label} · 解析 ${(elapsedMs / 1000).toFixed(1)}s · 点「保存到文件」写回${slowHint}`,
  );
}
