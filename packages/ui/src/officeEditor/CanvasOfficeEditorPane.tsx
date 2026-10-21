/**
 * 应用内 DOCX 编辑位（canvas-editor 引擎）。
 *
 * 为什么换掉 SuperDoc：真机在同一份压测文档（6000 修订 / 2.2 MB document.xml）上"很卡、几乎不可用"，
 * 且观感是网页工具栏而不是文档编辑器。canvas-editor 是 **canvas 渲染的编辑器**（MIT，壳 808 KB +
 * docx 插件 711 KB），光标/选区/分页/格式工具栏/表格/图片俱全，大文档也顺，体积只有 1.5 MB（对手 25 MB）。
 *
 * 与产品的其余部分保持一致：
 * - 字节来自 `IFileService.readBinaryPreview`，保存走 `writeBinaryFile`（写前比对 size/mtime、sibling 备份、原子替换）；
 * - 保存是显式的，冲突时拒绝写入并提示；**导入前先过护栏**（`docxPreflight.ts`）：引擎保不住的特性
 *   （修订/超链接/公式/批注/脚注/编号…）会先列清楚再让用户决定，绝不静默改坏文档。
 *
 * 已知边界（写在界面上，不假装）：本轮**不做** Word 修订记录（我们的改写不会落成 `w:ins`/`w:del`，
 * 所以护栏会把别人的修订按"接受"处理并如实告知）；要把改动进审查队列，请用对话卡片/插件审阅路径。
 */
import Editor from "@hufe921/canvas-editor";
import docxPlugin from "@hufe921/canvas-editor-plugin-docx";
import type { IFileService } from "@zcode/services";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CommentAnchor } from "./useCommentGroups.js";
import { OfficeCommentList } from "./OfficeCommentList.js";
import { OfficeEditorSurface } from "./OfficeEditorSurface.js";
import { gotoRevisionWithStatus } from "./officeReviewNavigation.js";
import { OfficeGuardNotices } from "./OfficeGuardNotices.js";
import { OfficeEditorToolbar } from "./OfficeEditorToolbar.js";
import { OfficeRibbon } from "./OfficeRibbon.js";
import type { EngineCommand } from "./engineCommands.js";

import { createEditorOptions, createInitialData } from "./officeEditorOptions.js";
import { scrollAfterZoom } from "./pageViewport.js";
import { useOfficeDocument } from "./useOfficeDocument.js";
import { createLayoutHistory, type LayoutHistory } from "./engineLayoutHistory.js";
import { createFindSession, runEngineCommand } from "./officeEditorCommands.js";
import type { RibbonStyle } from "./officeRibbonModel.js";

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
  /** 远端工作区：载入前先探一次写能力（老远端没有 writeBinaryFile）。 */
  remote?: boolean;
  /** 脏标记外报：外层在切换文件/退出编辑态时据此拦一下，避免静默丢改动。 */
  onDirtyChange?: (dirty: boolean) => void;
  onExit?: () => void;
}

export function CanvasOfficeEditorPane({
  fileService,
  path,
  remote,
  onDirtyChange,
  onExit,
}: CanvasOfficeEditorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<CanvasEditor | null>(null);
  const {
    status,
    setStatus,
    dirty,
    setDirty,
    busy,
    pendingPreflight,
    writeBlocked,
    comments,
    currentComment,
    gotoComment,
    deleteComment,
    measureComments,
    revisions,
    currentRevision,
    setCurrentRevision,
    resolveRevision,
    revisionSummary,
    trackChangesEnabled,
    setTrackChangesEnabled,
    loadDocument,
    acceptPreflight,
    save,
  } = useOfficeDocument({ fileService, path, editorRef, remote, onDirtyChange });
  const [rangeStyle, setRangeStyle] = useState<RibbonStyle | null>(null);
  const [inTable, setInTable] = useState(false);
  // 引擎按容器宽度铺画布、页面从 x=0 起画（天生贴左）。所以把编辑区宽度收到**纸张宽度**，
  // 再由外层 flex 居中——这就是 Word/WPS「纸张居中、两侧留灰边」的做法（真机反馈）。
  const [pageSize, setPageSize] = useState({ width: 794, scale: 1 });
  /** 批注锚点位置（Word 的批注框要贴在对齐锚点的高度上）。 */
  const [commentAnchors, setCommentAnchors] = useState<Map<string, CommentAnchor>>(new Map());

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
   * 重新量批注锚点：导入后、缩放后、内容变化后都要量（Word 的批注框跟着文字动）。
   * 内容变化用 200ms 去抖，避免每次按键都算一遍。
   */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || comments.length === 0) {
      setCommentAnchors(new Map());
      return;
    }
    const measure = () => setCommentAnchors(measureComments(editor, comments, pageSize.scale));
    const timer = setTimeout(measure, 120);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", measure);
    };
  }, [comments, editorRef, measureComments, pageSize.scale, pageSize.width]);

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
          review: {
            acceptCurrent: () =>
              void resolveRevision("accept", currentRevision >= 0 ? currentRevision : undefined),
            acceptAll: () => void resolveRevision("accept"),
            rejectCurrent: () =>
              void resolveRevision("reject", currentRevision >= 0 ? currentRevision : undefined),
            rejectAll: () => void resolveRevision("reject"),
            prev: () =>
              gotoRevisionWithStatus({
                editorRef,
                revisions,
                index:
                  currentRevision <= 0 ? Math.max(0, revisions.length - 1) : currentRevision - 1,
                setCurrentRevision,
                setStatus,
                scrollContainer: scrollRef.current,
                scale: pageSize.scale,
              }),
            next: () =>
              gotoRevisionWithStatus({
                editorRef,
                revisions,
                index: currentRevision + 1 >= revisions.length ? 0 : currentRevision + 1,
                setCurrentRevision,
                setStatus,
                scrollContainer: scrollRef.current,
                scale: pageSize.scale,
              }),
            count: () => ({ total: revisions.length, current: currentRevision }),
          },
          comments: {
            prev: () => gotoComment(currentComment <= 0 ? comments.length - 1 : currentComment - 1),
            next: () => gotoComment(currentComment + 1 >= comments.length ? 0 : currentComment + 1),
          },
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
    [
      currentRevision,
      setCurrentRevision,
      engineState,
      refreshEngineUndo,
      resolveRevision,
      revisions.length,
      syncLayoutState,
    ],
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
        extra={
          <>
            {revisionSummary.inserted || revisionSummary.deleted || revisionSummary.comments ? (
              <span
                className="rounded border border-border px-2 py-1 text-foreground-subtle"
                title="修订按 Word 的方式显示在正文里（插入＝下划线着色、删除＝红色删除线、批注＝上标标记）；用「审阅」标签逐条接受/拒绝，保存时未处理的修订原样写回"
              >
                修订 {revisions.length} 条
                {currentRevision >= 0 ? `（当前第 ${currentRevision + 1} 条）` : ""} · 批注{" "}
                {revisionSummary.comments} 处
              </span>
            ) : null}
            <label
              className="flex items-center gap-1 rounded border border-border px-2 py-1"
              title="保存时把本次改动写成 Word 修订（w:ins/w:del），可回对话卡片逐条接受/拒绝"
            >
              <input
                type="checkbox"
                checked={trackChangesEnabled}
                onChange={(event) => setTrackChangesEnabled(event.target.checked)}
              />
              修订模式
            </label>
          </>
        }
      />
      <OfficeGuardNotices
        writeBlocked={writeBlocked}
        pending={pendingPreflight}
        onAccept={acceptPreflight}
        onExit={onExit}
      />
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
      {/* 无锚点的批注（正文里找不到对应文字）兜底列出来；有锚点的都走右侧批注框 */}
      {comments.some((comment) => !commentAnchors.get(comment.id)?.anchor) ? (
        <OfficeCommentList
          comments={comments.filter((comment) => !commentAnchors.get(comment.id)?.anchor)}
          current={-1}
          onPick={() => undefined}
          onDelete={(index) => void deleteComment(index)}
        />
      ) : null}
      <OfficeEditorSurface
        hostRef={hostRef}
        scrollRef={scrollRef}
        hidden={writeBlocked !== null || pendingPreflight !== null}
        pageWidth={Math.round(pageSize.width * pageSize.scale)}
        comments={comments}
        anchors={commentAnchors}
        activeComment={currentComment}
        onPickComment={gotoComment}
        onDeleteComment={(index) => void deleteComment(index)}
      />
    </div>
  );
}
