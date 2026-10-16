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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { OfficeEditorToolbar } from "./OfficeEditorToolbar.js";
import { OfficeRibbon } from "./OfficeRibbon.js";
import type { EngineCommand } from "./engineCommands.js";
import { createEditorOptions, createInitialData } from "./officeEditorOptions.js";
import { scrollAfterZoom } from "./pageViewport.js";
import {
  createFindSession,
  createLayoutHistory,
  runEngineCommand,
  type LayoutHistory,
} from "./officeEditorCommands.js";
import type { RibbonStyle } from "./officeRibbonModel.js";
import { logger } from "@/logger.js";

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
  listener: { contentChange?: () => void };
  command: Record<string, (...args: unknown[]) => unknown>;
  /** 引擎内部元素表：`getValue()` 会把同格式的连续文字合并，替换要靠真实下标（见 engineCommands）。 */
  draw?: unknown;
};

/** 引擎 getOptions() 里我们用到的字段（纸张尺寸、缩放、模式、痕迹开关）。 */
interface EngineOptions {
  width?: number;
  height?: number;
  scale?: number;
  mode?: string;
  pageMode?: string;
  trace?: { disabled?: boolean };
}

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
  // 引擎按容器宽度铺画布、页面从 x=0 起画（天生贴左）。所以把编辑区宽度收到**纸张宽度**，
  // 再由外层 flex 居中——这就是 Word/WPS「纸张居中、两侧留灰边」的做法（真机反馈）。
  const [pageSize, setPageSize] = useState({ width: 794, scale: 1 });

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
      await editor.command.executeImportDocx({
        arrayBuffer: base64ToArrayBuffer(preview.dataBase64),
      });
      const elapsedMs = Math.round(performance.now() - startedAt);
      logger.info(
        `[OfficeEditor] canvas-editor 导入完成 ${elapsedMs}ms（${Math.round(preview.totalBytes / 1024)} KiB）`,
      );
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
    // 三个参数：容器、初始数据、选项（漏掉第二个参数会让选项被当成数据，静默失效）
    const editor = new Editor(
      host,
      createInitialData(),
      createEditorOptions({ scrollContainerSelector: "#office-editor-scroll" }),
    ) as unknown as CanvasEditor;
    editor.use(docxPlugin);
    editor.listener.contentChange = () => setDirty(true);
    syncLayoutState(editor);
    // 官方 demo 的做法：选中态由 rangeStyleChange 驱动，工具栏据此高亮 B/I/U/对齐/列表等。
    editor.listener.rangeStyleChange = (payload: RibbonStyle) => {
      setRangeStyle(payload as RibbonStyle);
      engineUndoRef.current = {
        canUndo: (payload as { undo?: boolean }).undo !== false,
        canRedo: (payload as { redo?: boolean }).redo !== false,
      };
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
      // docx 插件把导入/导出都注册在 `command` 上（不是编辑器实例本身）——之前按 SuperDoc 的写法
      // 读 `editor.executeExportDocx`，拿到 undefined 就会报"编辑器没有返回文档内容"（保存直接失败）。
      const exportDocx = (
        editor.command as {
          executeExportDocx?: (options: { fileName: string }) => Promise<Blob>;
        }
      ).executeExportDocx?.bind(editor.command);
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
   * 引擎没有"布局变了"的统一事件（纸张/页边距/模式切换都不发通知），所以每次命令后主动读一次
   * `getOptions()`：纸张宽度决定编辑区宽度（居中靠它），缩放/模式/痕迹决定功能区的显示状态。
   */
  const syncLayoutState = useCallback((editor: CanvasEditor) => {
    const options = (editor.command as { getOptions?: () => EngineOptions }).getOptions?.();
    if (!options) return;
    setPageSize({
      width: options.width ?? 794,
      scale: options.scale ?? 1,
    });
    setEngineState({
      mode: options.mode ?? "edit",
      pageMode: options.pageMode ?? "paging",
      traceDisabled: options.trace?.disabled ?? true,
    });
  }, []);

  const [engineState, setEngineState] = useState({
    mode: "edit",
    pageMode: "paging",
    traceDisabled: true,
  });

  /** 查找会话：功能区发起的查找/替换要在多条命令之间记住关键词与当前位置。 */
  const findRef = useRef({ current: createFindSession() });
  /** 版面撤销栈（纸张/页边距/分栏不在引擎的元素表历史里，见 officeEditorCommands 注释）。 */
  const layoutRef = useRef<LayoutHistory>(createLayoutHistory());
  /** 上一次缩放：用来把滚动位置按比例换算（否则缩放后视图跳到左上角）。 */
  const lastScaleRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 引擎自己的撤销/重做可用性：由 rangeStyleChange 回填。 */
  const engineUndoRef = useRef({ canUndo: false, canRedo: false });
  // 只用来触发重渲染：版面栈/撤销可用性发生在 React 之外，功能区要重算"撤销是否能点"
  const [, setHistoryVersion] = useState(0);

  /**
   * 缩放后把滚动位置按比例搬过去（DOM 已更新完再算，避免读到旧的滚动范围）。
   * 横向没有滚动余地时归零——页面变窄后靠外层 `mx-auto` 居中。
   */
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const previous = lastScaleRef.current;
    const next = pageSize.scale;
    if (!container || previous === next) {
      lastScaleRef.current = next;
      return;
    }
    const { scrollTop, scrollLeft } = scrollAfterZoom({
      scrollTop: container.scrollTop,
      scrollLeft: container.scrollLeft,
      viewportWidth: container.clientWidth,
      viewportHeight: container.clientHeight,
      contentWidth: pageSize.width * next,
      contentHeight: container.scrollHeight,
      prevScale: previous,
      nextScale: next,
    });
    container.scrollTop = scrollTop;
    container.scrollLeft = scrollLeft;
    lastScaleRef.current = next;
  }, [pageSize.scale, pageSize.width]);

  /**
   * 问引擎"现在还能撤吗"。rangeStyleChange 会带 undo/redo，但只在新选区出现时推送，
   * 所以先按当前选区触发一次（不改变选区本身），再读回填结果。
   */
  const refreshEngineUndo = useCallback((editor: CanvasEditor) => {
    const commands = editor.command as EngineCommand;
    const range = commands.getRange?.() as { startIndex?: number; endIndex?: number } | undefined;
    if (range && typeof range.startIndex === "number" && range.startIndex >= 0) {
      commands.executeSetRange?.(range.startIndex, range.endIndex ?? range.startIndex);
    }
    return engineUndoRef.current;
  }, []);

  /**
   * 功能区入口：命令交给 officeEditorCommands 调度，调度完同步一次编辑器状态
   * （纸张/缩放/模式/痕迹都没有引擎事件，不主动读就会显示旧值）。
   */
  const runRibbon = useCallback(
    (command: string, args?: unknown[]) => {
      const editor = editorRef.current;
      if (!editor) return;
      runEngineCommand(
        {
          editor: editor as unknown as { command: Record<string, unknown>; draw?: unknown },
          commands: editor.command as EngineCommand,
          status: setStatus,
          engineState,
          findRef: findRef.current,
          layoutRef: layoutRef as { current: LayoutHistory },
          canUndoEngine: () => refreshEngineUndo(editor).canUndo,
          canRedoEngine: () => refreshEngineUndo(editor).canRedo,
        },
        command,
        args,
      );
      syncLayoutState(editor);
      // 版面栈与撤销可用性发生在 React 之外，版本号变化让功能区重算"撤销是否能点"
      setHistoryVersion((current) => current + 1);
    },
    [engineState, refreshEngineUndo, syncLayoutState],
  );

  /**
   * Ctrl/⌘+Z 的接管：引擎自己的快捷键只撤元素表（文本），版面改动撤不动。
   * 所以先问引擎能不能撤——能就交给引擎；不能而我们有版面快照时，才拦下来撤版面。
   */
  const onKeyDownCapture = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "z") return;
      const editor = editorRef.current;
      if (!editor) return;
      const engine = refreshEngineUndo(editor);
      const redo = event.shiftKey;
      if (redo ? engine.canRedo : engine.canUndo) return;
      const history = layoutRef.current;
      if ((redo ? history.redo : history.undo).length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      runRibbon(redo ? "executeRedo" : "executeUndo");
    },
    [refreshEngineUndo, runRibbon],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDownCapture={onKeyDownCapture}>
      <OfficeEditorToolbar
        busy={busy}
        dirty={dirty}
        status={status}
        onSave={() => void save()}
        onReload={() => {
          void (async () => {
            setStatus("重新加载文档…");
            await loadDocument();
          })().catch((error) => setStatus(`重新加载失败：${String(error)}`));
        }}
        onExit={onExit}
        confirmExit={() => !dirty || window.confirm("有未保存的修改，确定退出编辑吗？")}
      />
      {/* 容器必须可滚动：canvas-editor 把所有页面画在同一张 canvas 上，滚动由外层承担。
          之前沿用 SuperDoc 版的 overflow-hidden，导致"无法滚动"——真机反馈。 */}
      <OfficeRibbon
        style={{
          ...rangeStyle,
          // 引擎撤不动但版面栈还有货时，撤销按钮必须仍然可点（否则用户点了灰按钮以为坏了）
          undo: rangeStyle?.undo !== false || layoutRef.current.undo.length > 0,
          redo: rangeStyle?.redo !== false || layoutRef.current.redo.length > 0,
          mode: engineState.mode,
          pageMode: engineState.pageMode,
          traceDisabled: engineState.traceDisabled,
          scale: pageSize.scale,
        }}
        inTable={inTable}
        run={runRibbon}
      />
      {/* 外层负责滚动；内层宽度＝纸张宽度×缩放，靠 mx-auto 居中（面板拉宽/变窄时纸张跟着居中）。 */}
      <div
        id="office-editor-scroll"
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto bg-surface"
      >
        <div
          ref={hostRef}
          id="office-editor-host"
          className="mx-auto"
          style={{ width: Math.round(pageSize.width * pageSize.scale) }}
        />
      </div>
    </div>
  );
}
