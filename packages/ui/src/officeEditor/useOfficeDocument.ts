/**
 * 编辑位的**文档生命周期**：读文件 → 护栏预检 → 导入 → 保存（含冲突/备份提示）。
 *
 * 抽出来的原因有两个：编辑位本体要守 400 行上限；更重要的是这些逻辑（尤其护栏与写回）
 * 属于"数据安全"路径，单独成文件后，读者能一眼看清"什么情况下我们不让编、什么情况下拒绝写"。
 */
import type { IFileService } from "@zcode/services";
import { useCallback, useEffect, useRef, useState } from "react";
import { base64ToArrayBuffer, bytesToBase64 } from "./binary.js";
import { preprocessDocx, summarizeFindings, type DocxPreflightResult } from "./docxPreflight.js";
import { preserveHeaderFooter } from "./docxHeaderFooter.js";
import {
  applyRevisionView,
  listRevisions,
  resolveRevisionsInDocx,
  restoreRevisions,
  type RevisionAction,
  type RevisionItem,
  type RevisionPreservationState,
} from "./docxRevisions.js";
import { applyTrackedChanges, type TrackedChangeStats } from "./docxTrackChanges.js";
import { probeWriteSupport } from "./fileWriteSupport.js";
import type { EngineCommand } from "./engineCommands.js";
import { logger } from "@/logger.js";

/** 取 docx 里 document.xml 的文本（审阅清单要按原始标记枚举）。 */
async function documentXmlOf(bytes: ArrayBuffer): Promise<string> {
  const { default: JSZip } = await import("jszip");
  return (await (await JSZip.loadAsync(bytes)).file("word/document.xml")?.async("string")) ?? "";
}

/** 应用内原地编辑的体积上限（docx 文件字节）。 */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;
/**
 * document.xml 的上限：**这才是真正的体量口径**。实测 191 KB 的 docx 解出 2.35 MB document.xml
 * （约 12 倍）、95.7 万个文字元素、导入 4.4 秒；按文件大小限流会放进一个几十 MB 的 document.xml，
 * 面板会长时间卡死甚至 OOM。
 */
const MAX_DOCUMENT_XML_BYTES = 4 * 1024 * 1024;
/** 解析超过这个时间就明确提示卡顿（实测：6000 段 957ms / 20000 段 4.4s）。 */
const SLOW_PARSE_MS = 3000;

export interface OfficeEditorHandle {
  command: Record<string, unknown>;
}

export interface UseOfficeDocumentInput {
  fileService: IFileService;
  path: string;
  editorRef: { current: OfficeEditorHandle | null };
  /** 远端工作区要探一次写能力（老远端没有 writeBinaryFile，编辑到最后才发现保存不了）。 */
  remote?: boolean;
  /** 脏标记变化往外报：外层据此在切换文件/退出编辑态时拦一下。 */
  onDirtyChange?: (dirty: boolean) => void;
}

export interface UseOfficeDocumentResult {
  /** 修订清单（Word 的"审阅"是按这个列表逐条走的）。 */
  revisions: RevisionItem[];
  /** 当前选中的修订序号（-1＝没选）。 */
  currentRevision: number;
  setCurrentRevision: (index: number) => void;
  /** 接受/拒绝某一条或全部（Word 的接受/拒绝语义）。 */
  resolveRevision: (action: RevisionAction, targetIndex?: number) => Promise<void>;
  /** 文档里检测到的修订/批注数（按 Word 的方式显示，不再用横幅告知）。 */
  revisionSummary: { inserted: number; deleted: number; comments: number };
  /** 修订模式开关（保存时是否把改动记成 w:ins/w:del）。 */
  trackChangesEnabled: boolean;
  setTrackChangesEnabled: (value: boolean) => void;
  /** 非空表示这份文件不能写回（远端缺能力），编辑位据此只显示说明。 */
  writeBlocked: string | null;
  status: string;
  setStatus: (message: string) => void;
  dirty: boolean;
  setDirty: (value: boolean) => void;
  busy: boolean;
  pendingPreflight: DocxPreflightResult | null;
  /** 读文件 → 预检 → 导入。需要用户确认的特性会停在横幅上（见 pendingPreflight）。 */
  loadDocument: (options?: { reset?: boolean; skipGuard?: boolean }) => Promise<void>;
  /** 用户在护栏横幅上点"按上述方式编辑"：用归一化后的字节导入。 */
  acceptPreflight: () => void;
  /** 导出并写回原文件（版本比对失败即拒绝）。 */
  save: () => Promise<void>;
}

export function useOfficeDocument({
  fileService,
  path,
  editorRef,
  remote,
  onDirtyChange,
}: UseOfficeDocumentInput): UseOfficeDocumentResult {
  const revisionRef = useRef<{ size: number; mtimeMs: number } | null>(null);
  /** 源文件字节：保存时要用它把原页眉页脚还给导出结果（编辑器不编辑页眉页脚）。 */
  const sourceBytesRef = useRef<ArrayBuffer | null>(null);
  /** 导入时保留下来的"修订/批注段落原件"：保存时按段落写回，避免静默接受或丢失。 */
  const revisionsRef = useRef<RevisionPreservationState>({ paragraphs: [] });
  const [revisionSummary, setRevisionSummary] = useState({ inserted: 0, deleted: 0, comments: 0 });
  /** 文档里的修订清单（Word 的"审阅"面板就是按这个列表逐条走的）。 */
  const [revisions, setRevisions] = useState<RevisionItem[]>([]);
  const [currentRevision, setCurrentRevision] = useState(-1);
  /** 归一化前的原始字节：审阅动作在这份字节上做，做完重新导入。 */
  const normalizedBytesRef = useRef<ArrayBuffer | null>(null);
  const [status, setStatus] = useState("正在加载文档…");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingPreflight, setPendingPreflight] = useState<DocxPreflightResult | null>(null);
  const [writeBlocked, setWriteBlocked] = useState<string | null>(null);
  /**
   * 修订模式（默认开）：保存时把本次改动记成 `w:ins`/`w:del`，于是改动能进审阅队列
   * （对话卡片逐条接受/拒绝走的就是这套标记）。关掉它就是"直接改文档"。
   */
  const [trackChangesEnabled, setTrackChangesEnabled] = useState(true);

  const markDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirtyChange?.(value);
    },
    [onDirtyChange],
  );

  // 未保存内容守卫：关窗口/刷新时拦一下（Electron 会弹系统确认框）
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const importBytes = useCallback(
    async (editor: OfficeEditorHandle, bytes: ArrayBuffer, label: string, reset: boolean) => {
      setStatus(`解析文档（${label}）…`);
      const startedAt = performance.now();
      await (
        editor.command.executeImportDocx as (payload: { arrayBuffer: ArrayBuffer }) => Promise<void>
      )({
        arrayBuffer: bytes,
      });
      const elapsedMs = Math.round(performance.now() - startedAt);
      logger.info(`[OfficeEditor] canvas-editor 导入完成 ${elapsedMs}ms（${label}）`);
      if (reset) markDirty(false);
      const slowHint =
        elapsedMs > SLOW_PARSE_MS
          ? `（文档很大，编辑会明显卡顿：${Math.round(elapsedMs / 1000)}s 解析。建议改用只读预览 + 卡片审阅。）`
          : "";
      setStatus(
        `已载入 ${label} · 解析 ${(elapsedMs / 1000).toFixed(1)}s · 点「保存到文件」写回${slowHint}`,
      );
    },
    [],
  );

  const loadDocument = useCallback(
    async (options: { reset?: boolean; skipGuard?: boolean } = {}) => {
      const [preview, fileStat] = await Promise.all([
        fileService.readBinaryPreview({ path }),
        fileService.stat({ path }),
      ]);
      revisionRef.current =
        typeof fileStat.mtimeMs === "number"
          ? { size: preview.totalBytes, mtimeMs: fileStat.mtimeMs }
          : null;
      const editor = editorRef.current;
      if (!editor) return;
      if (remote) {
        const probe = await probeWriteSupport(fileService, path);
        if (!probe.supported) {
          setWriteBlocked(probe.reason ?? "服务端不支持写回");
          setStatus(
            `远端工作区不支持应用内编辑：${probe.reason ?? "服务端不支持写回"}。请用只读预览 + 对话卡片审阅。`,
          );
          return;
        }
        setWriteBlocked(null);
      }
      if (preview.totalBytes > MAX_EDITABLE_BYTES) {
        setStatus(
          `文档过大（${Math.round(preview.totalBytes / 1048576)} MB），不在应用内编辑：请用只读预览 + 对话卡片审阅，或分段编辑。`,
        );
        return;
      }
      const raw = base64ToArrayBuffer(preview.dataBase64);
      sourceBytesRef.current = raw;
      const label = `${Math.round(preview.totalBytes / 1024)} KiB`;
      // 护栏：先看清这份文档里有什么是引擎**保不住**的。实测修订的插入文字、超链接文字、公式文字会直接消失；
      // 批注/脚注在保存时丢——所以先把话说明白，用户确认后才按归一化字节导入。
      let preflightBytes = raw;
      if (!options.skipGuard) {
        const preflight = await preprocessDocx(raw);
        preflightBytes = preflight.bytes;
        if (preflight.findings.documentXmlBytes > MAX_DOCUMENT_XML_BYTES) {
          setStatus(
            `文档解压后过大（document.xml ${(preflight.findings.documentXmlBytes / 1048576).toFixed(1)} MB，上限 ${MAX_DOCUMENT_XML_BYTES / 1048576} MB）：应用内编辑会卡到不可用，请用只读预览 + 对话卡片审阅。`,
          );
          return;
        }
        const notices = summarizeFindings(preflight.findings);
        if (notices.length > 0) {
          setPendingPreflight(preflight);
          setStatus("这份文档有需要你确认的特性（见上方提示）——确认后才会打开");
          return;
        }
      }
      // 修订与批注：按 Word 的样子显示在正文里（插入＝下划线着色、删除＝红色删除线、批注＝上标标记），
      // 原件留起来，保存时按段落原样写回（见 docxRevisions.ts）。
      normalizedBytesRef.current = preflightBytes;
      const view = await applyRevisionView(preflightBytes);
      revisionsRef.current = view.preservation;
      setRevisions(listRevisions(await documentXmlOf(preflightBytes)));
      setCurrentRevision(-1);
      setRevisionSummary(view.summary);
      await importBytes(editor, view.bytes, label, options.reset !== false);
      if (view.summary.inserted || view.summary.deleted || view.summary.comments) {
        setStatus(
          `已载入 ${label} · 修订 ${view.summary.inserted} 插入 / ${view.summary.deleted} 删除 · 批注 ${view.summary.comments} 处（按 Word 的方式显示在正文里，保存时原样写回）`,
        );
      }
    },
    [editorRef, fileService, importBytes, path, remote],
  );

  /**
   * 审阅动作（Word 的接受/拒绝）：在**归一化前的原始字节**上做，做完重新导入。
   *
   * 为什么要重新导入而不是在引擎里改文字：修订是"文档结构"层面的东西（`w:ins`/`w:del` 元素），
   * 在正文里它们只是被我们染了色的普通文字；直接改文字既分不清"这是第几条修订"，也没法把结果写回文件。
   * 在字节层做、再导入，语义与 Word 完全一致（接受＝拆壳、拒绝＝删掉/还原），而且结果可断言。
   * 副作用是"当前未保存的编辑会被这次导入覆盖"——Word 的接受/拒绝也是立刻改文档，所以行为一致。
   */
  const resolveRevision = useCallback(
    async (action: RevisionAction, targetIndex?: number) => {
      const editor = editorRef.current;
      const base = normalizedBytesRef.current;
      if (!editor || !base) return;
      setBusy(true);
      try {
        const result = await resolveRevisionsInDocx(base, {
          action,
          ...(targetIndex === undefined ? {} : { targetIndex }),
        });
        const handledText =
          result.handled.length === 1
            ? `第 ${(result.handled[0]?.index ?? 0) + 1} 条`
            : `${result.handled.length} 条`;
        setStatus(`${action === "accept" ? "已接受" : "已拒绝"} ${handledText}修订 · 重新载入…`);
        // 处理后这份字节成为新的"原始状态"：C2 的差异对比、下一次审阅都基于它
        normalizedBytesRef.current = result.bytes;
        sourceBytesRef.current = result.bytes;
        const view = await applyRevisionView(result.bytes);
        revisionsRef.current = view.preservation;
        setRevisions(result.remaining);
        setCurrentRevision(-1);
        setRevisionSummary(view.summary);
        await importBytes(editor, view.bytes, "审阅后的文档", true);
        setStatus(
          `${action === "accept" ? "已接受" : "已拒绝"} ${handledText}修订 · 剩余 ${result.remaining.length} 条${
            result.remaining.length ? "" : "（已无修订）"
          }`,
        );
      } catch (error) {
        setStatus(`审阅操作失败：${String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [editorRef, importBytes],
  );

  const acceptPreflight = useCallback(() => {
    const pending = pendingPreflight;
    setPendingPreflight(null);
    const editor = editorRef.current;
    if (!pending || !editor) return;
    void importBytes(editor, pending.bytes, "预处理后的文档", true).catch((error) =>
      setStatus(`打开失败：${String(error)}`),
    );
  }, [editorRef, importBytes, pendingPreflight]);

  const save = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || busy) return;
    setBusy(true);
    try {
      setStatus("导出 docx…");
      // docx 插件把导入/导出都注册在 `command` 上（不是编辑器实例本身）——按 SuperDoc 的写法读
      // `editor.executeExportDocx` 会拿到 undefined，保存必然报"编辑器没有返回文档内容"。
      const exportDocx = (editor.command as EngineCommand).executeExportDocx as
        | ((options: { fileName: string }) => Promise<Blob>)
        | undefined;
      const blob = exportDocx
        ? await exportDocx({ fileName: path.split("/").pop() ?? "document.docx" })
        : null;
      if (!(blob instanceof Blob)) throw new Error("编辑器没有返回文档内容");
      const exported = await blob.arrayBuffer();
      // 修订模式：把改动落成 w:ins/w:del（基线＝打开时的文件字节）
      let trackedStats: TrackedChangeStats | null = null;
      let withTracked = exported;
      if (trackChangesEnabled && sourceBytesRef.current) {
        const tracked = await applyTrackedChanges(sourceBytesRef.current, exported, {
          author: "UWork",
          date: new Date().toISOString(),
        });
        withTracked = tracked.bytes;
        trackedStats = tracked.stats;
      }
      // 页眉页脚不属于本次编辑范围：原样保留（没有就别让插件默认页脚留下来）
      // 修订/批注写回：没被编辑过的段落换回原件（标记不丢、不被静默接受）
      const revisions = await restoreRevisions(withTracked, revisionsRef.current);
      const restored = sourceBytesRef.current
        ? await preserveHeaderFooter(sourceBytesRef.current, revisions.bytes)
        : { bytes: revisions.bytes, note: "" };
      const bytes = new Uint8Array(restored.bytes);
      setStatus(`写回文件（${Math.round(bytes.length / 1024)} KiB）…`);
      const result = await fileService.writeBinaryFile({
        path,
        dataBase64: bytesToBase64(bytes),
        ...(revisionRef.current ? { expectedRevision: revisionRef.current } : {}),
        backup: "sibling",
      });
      revisionRef.current = result.revision;
      markDirty(false);
      const backupName = result.backup ? result.backup.split("/").pop() : "";
      const revisionNote = revisions.restored
        ? ` · 保留原修订/批注 ${revisions.restored} 段${
            revisions.edited ? `（${revisions.edited} 段被编辑过，其原有标记按你的改动处理）` : ""
          }`
        : "";
      const trackedNote = trackedStats
        ? ` · 已记为修订（插入 ${trackedStats.inserted} 段 / 删除 ${trackedStats.deleted} 段 / 修改 ${trackedStats.modified} 段）`
        : "";
      setStatus(
        `已保存到 ${path} · ${Math.round(result.bytes / 1024)} KiB${backupName ? ` · 备份 ${backupName}` : ""}${
          restored.note ? ` · ${restored.note}` : ""
        }${revisionNote}${trackedNote}`,
      );
      // 保存后基线要更新：否则第二次保存会把上一次的改动又标一遍
      sourceBytesRef.current = withTracked.slice(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(
        message.includes("revision mismatch")
          ? "保存被拒：文件已被其它程序（可能是 Agent）修改。请「重新加载」或另存副本后再改。"
          : `保存失败：${message}`,
      );
    } finally {
      setBusy(false);
    }
  }, [busy, editorRef, fileService, path, trackChangesEnabled]);

  return {
    revisions,
    currentRevision,
    setCurrentRevision,
    resolveRevision,
    revisionSummary,
    trackChangesEnabled,
    setTrackChangesEnabled,
    status,
    setStatus,
    dirty,
    setDirty: markDirty,
    writeBlocked,
    busy,
    pendingPreflight,
    loadDocument,
    acceptPreflight,
    save,
  };
}
