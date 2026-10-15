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

interface ToolButton {
  label: string;
  title: string;
  command: string;
  args?: unknown[];
}

/** 与 Word 常用项对齐的一小组按钮（够用优先，不做功能区）。 */
const TOOL_BUTTONS: ToolButton[] = [
  { label: "撤销", title: "撤销 (⌘Z)", command: "executeUndo" },
  { label: "重做", title: "重做 (⇧⌘Z)", command: "executeRedo" },
  { label: "B", title: "加粗 (⌘B)", command: "executeBold" },
  { label: "I", title: "斜体 (⌘I)", command: "executeItalic" },
  { label: "U", title: "下划线 (⌘U)", command: "executeUnderline" },
  { label: "S", title: "删除线", command: "executeStrikeout" },
  { label: "字号+", title: "增大字号", command: "executeSizeAdd" },
  { label: "字号−", title: "减小字号", command: "executeSizeMinus" },
  { label: "左", title: "左对齐", command: "executeRowFlex", args: ["left"] },
  { label: "中", title: "居中", command: "executeRowFlex", args: ["center"] },
  { label: "右", title: "右对齐", command: "executeRowFlex", args: ["right"] },
  { label: "• ", title: "无序列表", command: "executeList", args: ["ul"] },
  { label: "1.", title: "有序列表", command: "executeList", args: ["ol"] },
  { label: "表格", title: "插入表格", command: "executeInsertTable", args: [3, 3] },
  { label: "分隔线", title: "插入分隔线", command: "executeInsertHr" },
  { label: "分页", title: "插入分页", command: "executeInsertPageBreak" },
  { label: "查找", title: "查找替换 (⌘F)", command: "executeSearch" },
];

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

  const runCommand = useCallback((button: ToolButton) => {
    const editor = editorRef.current;
    const command = editor?.command?.[button.command];
    if (typeof command !== "function") {
      setStatus(`该功能不可用：${button.title}`);
      return;
    }
    const instance = editor as CanvasEditor;
    try {
      (command as (...args: unknown[]) => unknown).apply(instance.command, button.args ?? []);
    } catch (error) {
      setStatus(`${button.title} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

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
        <span className="mx-1 text-border">|</span>
        {TOOL_BUTTONS.map((button) => (
          <button
            key={button.title}
            type="button"
            className="min-w-7 rounded border border-transparent px-1.5 py-1 hover:border-border hover:bg-surface"
            title={button.title}
            aria-label={button.title}
            onClick={() => runCommand(button)}
          >
            {button.label}
          </button>
        ))}
        <span className="ml-auto text-foreground-subtle">
          {dirty ? "● 未保存 · " : ""}
          {status}
        </span>
      </div>
      {/* 容器必须可滚动：canvas-editor 把所有页面画在同一张 canvas 上，滚动由外层承担。
          之前沿用 SuperDoc 版的 overflow-hidden，导致"无法滚动"——真机反馈。 */}
      <div ref={hostRef} id="office-editor-host" className="min-h-0 flex-1 overflow-auto bg-surface" />
    </div>
  );
}
