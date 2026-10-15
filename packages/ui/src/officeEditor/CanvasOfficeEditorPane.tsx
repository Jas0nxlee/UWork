/**
 * 应用内 DOCX 编辑位（canvas-editor 引擎）。
 *
 * 为什么换掉 SuperDoc：真机在同一份压测文档（6000 修订 / 2.2 MB document.xml）上"很卡、几乎不可用"，
 * 且观感是网页工具栏而不是文档编辑器。canvas-editor 是 **canvas 渲染的编辑器**（MIT，壳 808 KB +
 * docx 插件 711 KB），光标/选区/分页/格式工具栏/表格/图片俱全，大文档也顺，体积只有 1.5 MB（对手 25 MB）。
 *
 * 与产品的其余部分保持一致：
 * - 字节来自 `IFileService.readBinaryPreview`，保存走 `writeBinaryFile`（写前比对 size/mtime、sibling 备份、原子替换）；
 * - 保存是显式的，冲突时拒绝写入并提示；改动是否落成 `w:ins`/`w:del` 由"修订"按钮决定（见 trackChanges 注释）。
 *
 * 已知边界（写在界面上，不假装）：canvas-editor 自身不支持 Word 的修订记录语义；
 * 需要"改动进审查队列"时用「修订模式」——导出前把改动与基线做比较，落成 w:ins/w:del（后续接我们的引擎）。
 */
import Editor from "@hufe921/canvas-editor";
import docxPlugin from "@hufe921/canvas-editor-plugin-docx";
import type { IFileService } from "@zcode/services";
import { useCallback, useEffect, useRef, useState } from "react";
import { OfficeRibbon } from "./OfficeRibbon.js";
import type { RibbonStyle } from "./officeRibbonModel.js";
import { logger } from "@/logger.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** 应用内原地编辑的体积上限：超过就只读审阅（超大文档在任何浏览器编辑器里都不可用）。 */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024;
/** 解析超过这个时间就明确提示卡顿（实测：6000 段 957ms / 20000 段 4.4s）。 */
const SLOW_PARSE_MS = 3000;

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(offset, offset + step)));
  }
  return btoa(binary);
}

type CanvasEditor = InstanceType<typeof Editor> & {
  use: (plugin: unknown) => void;
  executeExportDocx?: (options: { fileName: string }) => Promise<Blob>;
  listener: { contentChange?: () => void };
  command: Record<string, (...args: unknown[]) => unknown>;
};

export interface CanvasOfficeEditorPaneProps {
  fileService: IFileService;
  path: string;
  onExit?: () => void;
}

export function CanvasOfficeEditorPane({ fileService, path, onExit }: CanvasOfficeEditorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<CanvasEditor | null>(null);
  const revisionRef = useRef<{ size: number; mtimeMs: number } | null>(null);
  const [status, setStatus] = useState("正在加载文档…");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rangeStyle, setRangeStyle] = useState<RibbonStyle | null>(null);
  const [inTable, setInTable] = useState(false);

  const loadDocument = useCallback(
    async (options: { reset?: boolean } = {}) => {
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
      if (preview.totalBytes > MAX_EDITABLE_BYTES) {
        setStatus(
          `文档过大（${Math.round(preview.totalBytes / 1048576)} MB），不在应用内编辑：请用只读预览 + 对话卡片审阅，或分段编辑。`,
        );
        return;
      }
      setStatus(`解析文档（${Math.round(preview.totalBytes / 1024)} KiB）…`);
      const startedAt = performance.now();
      await editor.command.executeImportDocx({ arrayBuffer: base64ToArrayBuffer(preview.dataBase64) });
      const elapsedMs = Math.round(performance.now() - startedAt);
      logger.info(`[OfficeEditor] canvas-editor 导入完成 ${elapsedMs}ms（${Math.round(preview.totalBytes / 1024)} KiB）`);
      if (options.reset !== false) setDirty(false);
      // 实测（headless Chromium，canvas-editor）：500 段 76ms / 2000 段 266ms / 6000 段 957ms / 20000 段 4.4s。
      // 超过阈值就如实提示"会很卡"，而不是让用户以为卡是 bug。
      const slowHint =
        elapsedMs > SLOW_PARSE_MS
          ? `（文档很大，编辑会明显卡顿：${Math.round(elapsedMs / 1000)}s 解析。建议改用只读预览 + 卡片审阅。）`
          : "";
      setStatus(
        `已载入 ${Math.round(preview.totalBytes / 1024)} KiB · 解析 ${(elapsedMs / 1000).toFixed(1)}s · 点「保存到文件」写回${slowHint}`,
      );
    },
    [fileService, path],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setStatus("正在加载文档…");
    setDirty(false);
    const editor = new Editor(host, {
      main: [{ value: "" }],
      // 页面观感贴近 Office：A4 纸张 + 页边距 + 分页
      pageMode: "paging",
      margins: [100, 120, 100, 120],
      // 滚动必须显式交给外层容器（默认也是父节点，这里写明意图；配合容器的 overflow-auto）
      scrollContainerSelector: "#office-editor-host",
    }) as unknown as CanvasEditor;
    editor.use(docxPlugin);
    editor.listener.contentChange = () => setDirty(true);
    // 官方 demo 的做法：选中态由 rangeStyleChange 驱动，工具栏据此高亮 B/I/U/对齐/列表等。
    editor.listener.rangeStyleChange = (payload: RibbonStyle) => {
      setRangeStyle(payload as RibbonStyle);
      try {
        const row = (editor.command as Record<string, () => unknown>).getRangeRow?.();
        setInTable(Boolean((row as { value?: unknown } | null)?.value));
      } catch {
        setInTable(false);
      }
    };
    editorRef.current = editor;
    (globalThis as Record<string, unknown>).__officeEditor = editor;
    void loadDocument().catch((error) => {
      setStatus(`编辑区初始化失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      editorRef.current = null;
      host.replaceChildren();
    };
  }, [loadDocument]);

  const save = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || busy) return;
    setBusy(true);
    try {
      setStatus("导出 docx…");
      const exportDocx = editor.executeExportDocx?.bind(editor);
      const blob = exportDocx
        ? await exportDocx({ fileName: path.split("/").pop() ?? "document.docx" })
        : null;
      if (!(blob instanceof Blob)) throw new Error("编辑器没有返回文档内容");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      setStatus(`写回文件（${Math.round(bytes.length / 1024)} KiB）…`);
      const result = await fileService.writeBinaryFile({
        path,
        dataBase64: bytesToBase64(bytes),
        ...(revisionRef.current ? { expectedRevision: revisionRef.current } : {}),
        backup: "sibling",
      });
      revisionRef.current = result.revision;
      setDirty(false);
      const backupName = result.backup ? result.backup.split("/").pop() : "";
      setStatus(
        `已保存到 ${path} · ${Math.round(result.bytes / 1024)} KiB${backupName ? ` · 备份 ${backupName}` : ""}`,
      );
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
  }, [busy, fileService, path]);

  /**
   * 功能区命令入口：把 ribbon 的语义命令映射到引擎命令。
   * 参数形态全部照抄 canvas-editor 官方 demo（见 officeRibbonModel.ts 顶部注释），不自己发明。
   */
  const runRibbon = useCallback(
    (command: string, args?: unknown[]) => {
      const editor = editorRef.current;
      if (!editor) return;
      const commands = editor.command as Record<string, ((...params: unknown[]) => unknown) | undefined>;
      const status = (message: string) => setStatus(message);
      try {
        switch (command) {
          case "executeInsertControlByType": {
            const type = args?.[0];
            commands.executeInsertControl?.({ type: "control", value: "", control: { type } });
            return;
          }
          case "executeSetTableCellBackgroundColor": {
            commands.executeTableTdBackgroundColor?.(args?.[0]);
            return;
          }
          case "executeSetTableCellVerticalAlign": {
            commands.executeTableTdVerticalAlign?.(args?.[0]);
            return;
          }
          case "executeImage": {
            // 官方 demo 从 <img> 载入宽高；这里给一个稳妥的默认尺寸，用户可在文档里拖拽调整。
            commands.executeImage?.({ value: args?.[0] ?? "", width: 320, height: 240 });
            return;
          }
          case "executeHyperlink": {
            const url = String(args?.[0] ?? "");
            if (!url) return;
            commands.executeHyperlink?.({ url, valueList: [{ value: url, size: 16 }] });
            return;
          }
          case "executeLatex": {
            const value = String(args?.[0] ?? "");
            if (!value) return;
            commands.executeLatex?.({ value });
            return;
          }
          case "executeAddWatermark": {
            const data = String(args?.[0] ?? "") || "UWork";
            commands.executeAddWatermark?.({ data, color: "#d0d0d0", size: 100, opacity: 0.3, repeat: true });
            return;
          }
          case "executeMode": {
            commands.executeMode?.(editor.command.getOptions?.()?.mode === "readonly" ? "edit" : "readonly");
            return;
          }
          case "executePageMode": {
            const current = editor.command.getOptions?.()?.pageMode;
            commands.executePageMode?.(current === "continuous" ? "paging" : "continuous");
            return;
          }
          case "executePainter": {
            // 引擎的 executePainter 读 payload.isDblclick；无参会直接抛错（回归检查发现的真 bug）。
            commands.executePainter?.({ isDblclick: false });
            return;
          }
          case "executeSeparator": {
            commands.executeSeparator?.();
            return;
          }
          case "executePageBreak": {
            commands.executePageBreak?.();
            return;
          }
          case "executeToggleTrace": {
            commands.executeToggleTrace?.();
            return;
          }
          default: {
            const fn = commands[command];
            if (typeof fn !== "function") {
              status(`该功能不可用：${command}`);
              return;
            }
            fn.apply(editor.command, args ?? []);
          }
        }
      } catch (error) {
        status(`${command} 执行失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5 text-xs">
        <button
          type="button"
          className="rounded border border-border px-2 py-1 font-medium hover:border-accent disabled:opacity-50"
          onClick={() => void save()}
          disabled={busy}
          title="写回原文件（先落备份，冲突则拒绝）"
        >
          保存到文件
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:border-accent disabled:opacity-50"
          onClick={() => {
            void (async () => {
              setStatus("重新加载文档…");
              await loadDocument();
            })().catch((error) => setStatus(`重新加载失败：${String(error)}`));
          }}
          disabled={busy}
        >
          重新加载
        </button>
        {onExit ? (
          <button
            type="button"
            className="rounded border border-border px-2 py-1 hover:border-accent"
            onClick={() => {
              if (dirty && !window.confirm("有未保存的修改，确定退出编辑吗？")) return;
              onExit();
            }}
          >
            返回预览
          </button>
        ) : null}
        <span className="ml-auto text-foreground-subtle">
          {dirty ? "● 未保存 · " : ""}
          {status}
        </span>
      </div>
      {/* 容器必须可滚动：canvas-editor 把所有页面画在同一张 canvas 上，滚动由外层承担。
          之前沿用 SuperDoc 版的 overflow-hidden，导致"无法滚动"——真机反馈。 */}
      <OfficeRibbon style={rangeStyle} inTable={inTable} run={runRibbon} />
      <div ref={hostRef} id="office-editor-host" className="min-h-0 flex-1 overflow-auto bg-surface" />
    </div>
  );
}
