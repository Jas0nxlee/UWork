/**
 * PPTX 的**编辑位**（PowerPoint 形态：左边缩略图 / 中间画布 / 右边任务窗格）。
 *
 * 定位（写在界面上，不假装）：这是**保真补丁编辑器**——动画、母版、图表编辑没有；
 * 但"改文字/改文字格式/挪位置与大小/缩放/调层级/复制删除形状/新建文本框/幻灯片增删排序"都能做，
 * 而且**只改必要的那几个部件**：图片、母版、版式、动画、备注逐字节保留
 * （由 pptxValidate 的"未编辑部件必须逐字节一致"盯着）。
 *
 * 面板形式是照我们自己在用的渲染器（`@aiden0z/pptx-renderer`）官方 demo 与 PowerPoint 的形态做的：
 * 左栏真缩略图 + 中间画布（右下缩放）+ 右栏「设置形状格式」。不用富文本编辑器的理由见
 * specs/office-editors-triad.md：可用的 OSS pptx 编辑器只有 AGPL 的 PPTist（它的交互库 moveable 是 MIT）。
 */
import type { IFileService } from "@zcode/services";
import { useCallback as useStableCallback } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OfficeEditorToolbar } from "./OfficeEditorToolbar.js";
import { OfficeRibbon } from "./OfficeRibbon.js";
import { PptxFormatPane } from "./PptxFormatPane.js";
import { PptxSlideCanvas } from "./PptxSlideCanvas.js";
import { PptxSlideThumbnails } from "./PptxSlideThumbnails.js";
import { installPptxPaneDebug } from "./pptxPaneDebug.js";
import { PPTX_RIBBON_TABS } from "./pptxRibbonTabs.js";
import { pptxRibbonStyle } from "./pptxRibbonRun.js";
import { tableGridOn } from "./pptTableCellFormat.js";
import { cellBlockIndexOf } from "./pptTable.js";
import { shapeLines } from "./pptShapes.js";
import { usePptxDocument } from "./usePptxDocument.js";
import { usePptxRibbonRun } from "./usePptxRibbonRun.js";
import { usePptxPreview } from "./usePptxPreview.js";

export interface PptxEditorPaneProps {
  fileService: IFileService;
  path: string;
  remote?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onExit?: () => void;
}

export function PptxEditorPane({
  fileService,
  path,
  remote,
  onDirtyChange,
  onExit,
}: PptxEditorPaneProps) {
  const {
    status,
    setStatus,
    slides,
    dirty,
    busy,
    writeBlocked,
    loadDocument,
    save,
    revision,
    setBlockLines,
    shapesOf,
    setShapeBounds,
    setShapeFormat,
    setShapeParagraph,
    moveShape,
    patchTable,
    patchTableOp,
    notesOf,
    saveNotes,
    duplicateShape,
    removeShape,
    addTextBox,
    addSlideAction,
    duplicateSlideAction,
    deleteSlideAction,
    moveSlideAction,
    insertPictureAction,
    previewBuilds,
    previewError,
    rawPreviewBytes,
    modelXml,
  } = usePptxDocument({ fileService, path, remote, onDirtyChange });
  const [activeSlide, setActiveSlide] = useState(0);
  const [activeShape, setActiveShape] = useState<string | null>(null);
  /** 画布缩放百分比（100 = 适应宽度）：画布右下角与功能区「视图」都能改。 */
  const [zoom, setZoom] = useState(100);
  /**
   * 右侧「设置形状格式」窗格：**默认收起**——它一直占着 288px，中间的画布就被挤得没法看
   * （用户口径）。选中形状时自动弹出，点 ✕ 收起。
   */
  const [formatPane, setFormatPane] = useState(false);
  /**
   * 面板**占布局**、不浮层盖住画布：PowerPoint 是"面板一开，页面自动缩小、整页仍看得见"
   * （用户口径）。所以这里不再按宽度切成浮层，画布那边改成"适应窗口"缩放。
   */
  const paneFloating = false;
  /** 缩略图面板也能收起：窄的时候把它让给画布。 */
  const [thumbsOpen, setThumbsOpen] = useState(true);
  /** 一份文件只解析一次的预览文档：画布与左栏缩略图共用。 */
  const preview = usePptxPreview(rawPreviewBytes);
  /** 就地改字：正在编辑哪个形状（或表格的哪一格）、草稿文本。 */
  const [editing, setEditing] = useState<{
    shape: string;
    text: string;
    cell?: { row: number; col: number };
  } | null>(null);
  /**
   * 画布上选中的**一片**单元格（表格名 + 两个角，0 基）：表格工具按它定位。
   * 单选一格就是 (row0,col0) === (row1,col1)；在表格里按住拖能选一片（PowerPoint 的手势）。
   */
  const [cellRange, setCellRange] = useState<{
    table: string;
    row0: number;
    col0: number;
    row1: number;
    col1: number;
  } | null>(null);
  /** 文本框的 DOM 引用：画布双击"就地改字"要能把焦点移到对应的文本框上。 */
  const blockRefs = useRef(new Map<number, HTMLTextAreaElement>());

  useEffect(() => {
    setActiveSlide(0);
    setActiveShape(null);
    setFormatPane(false);
    setEditing(null);
    setCellRange(null);
  }, [path]);

  // 选中形状就自动把「设置形状格式」窗格打开（PowerPoint 里选中对象右边的窗格也是这个意思）
  useEffect(() => {
    if (activeShape) setFormatPane(true);
  }, [activeShape]);

  const slide = slides?.[activeSlide];
  const shapes = useMemo(
    () => (slide ? shapesOf(slide.partName) : []),
    // shapesOf 读的是**当前 XML**（不是 React state）：改动靠 revision 触发重算
    [shapesOf, slide, revision],
  );
  const shape = shapes.find((item) => item.name === activeShape) ?? null;
  /** 当前页的讲稿备注（读的是内存里的备注 XML，改过就跟着 revision 重算）。 */
  /** 表格网格线现状（右栏那个开关的状态；从当前 XML 现读，revision 触发重算）。 */
  const tableGrid = useMemo(() => {
    if (!slide || shape?.kind !== "graphicFrame") return false;
    const xml = modelXml(slide.partName);
    return xml ? tableGridOn(xml, shape.name) : false;
    // modelXml 读的是内存映射，靠 revision 触发重算
  }, [modelXml, revision, shape, slide]);

  const notes = useMemo(
    () => (slide ? notesOf(slide.partName) : { text: [], hasNotes: false }),
    // notesOf 读的是内存映射（不是 React state）：靠 revision 触发重算
    [notesOf, revision, slide],
  );

  const registerRef = useCallback((index: number, element: HTMLTextAreaElement | null) => {
    if (element) blockRefs.current.set(index, element);
    else blockRefs.current.delete(index);
  }, []);

  /** 双击表格的某一格 → 就地改这一格的文字（内容取自"单元格 → 文本块序号"那条映射）。 */
  /** 单元格 → 整页里的文本块序号（表格改字两处都靠它）。 */
  const cellIndexAt = useCallback(
    (table: string, row: number, col: number) => {
      const partName = slide?.partName;
      const xml = partName ? modelXml(partName) : null;
      return xml ? cellBlockIndexOf(xml, table, row, col) : null;
    },
    [modelXml, slide],
  );

  const beginCellEdit = useCallback(
    (table: string, row: number, col: number) => {
      const index = cellIndexAt(table, row, col);
      const lines =
        index === null ? [] : (slide?.blocks.find((b) => b.index === index)?.lines ?? []);
      setActiveShape(table);
      // 双击进编辑：选区收成这一格（拖动选一片之后双击某格，编辑的就是这一格）
      setCellRange({ table, row0: row, col0: col, row1: row, col1: col });
      setEditing({ shape: table, text: lines.join("\n"), cell: { row, col } });
    },
    [cellIndexAt, slide],
  );

  /**
   * 画布上双击某个形状 → 把焦点移到它的文字块。
   *
   * 形状（XML 里的 txBody）与文本框（readSlideText 的块）是两套编号，不该靠"顺序一样"来猜，
   * 所以按**文字内容**匹配（去掉空白再比）；匹配不上就退到这一页的第一个文本框并把话说明白。
   */
  const focusBlockOfShape = useCallback(
    (name: string) => {
      const target = shapes.find((item) => item.name === name);
      const wanted = (target ? shapeLines(target).join("\n") : "").replace(/\s+/g, "");
      const blocks = slide?.blocks ?? [];
      const matched = wanted
        ? blocks.find((block) => block.lines.join("\n").replace(/\s+/g, "") === wanted)
        : undefined;
      const block = matched ?? blocks[0];
      if (!block) {
        setStatus(`「${name}」这一页没有可编辑的文字块（图形/图片本身不带文字）`);
        return;
      }
      setFormatPane(true);
      setEditing(null);
      const element = blockRefs.current.get(block.index);
      element?.focus();
      element?.scrollIntoView({ block: "nearest" });
      if (matched) element?.select();
      else setStatus(`已在右侧打开第 ${block.index + 1} 个文本框（「${name}」没有独立文字块）`);
    },
    [setStatus, shapes, slide],
  );

  /** 页面尺寸（EMU）：插图片时按它等比摆放。 */
  const previewFrame = useStableCallback(
    () => ({
      width: Math.round((preview.pageWidth || 960) * 9525),
      height: Math.round((preview.pageHeight || 720) * 9525),
    }),
    [preview],
  );

  /** 功能区命令 → 编辑位已有的操作（命令清单在 pptxRibbonTabs.ts，两边一起改）。 */
  // 功能区命令的落点整块在 usePptxRibbonRun 里（编辑位只有这一行）
  const runRibbon = usePptxRibbonRun({
    slide,
    slides,
    activeSlide,
    shape,
    previewFrame,
    shapesOf,
    cellRange,
    setZoom,
    setStatus,
    addSlideAction,
    duplicateSlideAction,
    deleteSlideAction,
    moveSlideAction,
    addTextBox,
    duplicateShape,
    removeShape,
    moveShape,
    setShapeFormat,
    setShapeParagraph,
    patchTable,
    patchTableOp,
    insertPictureAction,
  });

  /**
   * 形状（XML 里的 txBody）与文本框（readSlideText 的块）是两套编号，不该靠"顺序一样"来猜——
   * 按**文字内容**（去掉空白）匹配出它的块编号；匹配不上返回 null（例如组里的形状）。
   */
  const blockIndexOfShape = useCallback(
    (name: string): number | null => {
      const target = shapes.find((item) => item.name === name);
      const wanted = (target ? shapeLines(target).join("\n") : "").replace(/\s+/g, "");
      if (!wanted) return null;
      const blocks = slide?.blocks ?? [];
      const matched = blocks.find((block) => block.lines.join("\n").replace(/\s+/g, "") === wanted);
      return matched ? matched.index : null;
    },
    [shapes, slide],
  );

  /** 双击形状：能对上文本块就**就地改字**；对不上（组里的形状等）退到右栏文本框。 */
  const beginTextEdit = useCallback(
    (name: string) => {
      const index = blockIndexOfShape(name);
      const target = shapes.find((item) => item.name === name);
      if (index === null || !target) {
        focusBlockOfShape(name);
        return;
      }
      setActiveShape(name);
      setEditing({ shape: name, text: shapeLines(target).join("\n") });
    },
    [blockIndexOfShape, focusBlockOfShape, shapes],
  );

  /** 提交就地改字：走的是同一条文本补丁（保存时仍然只写回改过的那几页）。 */
  const commitTextEdit = useCallback(() => {
    if (!editing) return;
    const index = editing.cell
      ? cellIndexAt(editing.shape, editing.cell.row, editing.cell.col)
      : blockIndexOfShape(editing.shape);
    if (index !== null && slide) setBlockLines(slide.partName, index, editing.text.split("\n"));
    setEditing(null);
  }, [blockIndexOfShape, cellIndexAt, editing, setBlockLines, slide]);

  // 与 Excel/Word 编辑位同款：把"看状态"的小口子挂到 globalThis，真机排查与自动化都用它
  useEffect(
    () =>
      installPptxPaneDebug({
        slideCount: () => slides?.length ?? 0,
        activePartName: () => slides?.[activeSlide]?.partName ?? null,
        shapes: () => {
          const partName = slides?.[activeSlide]?.partName;
          return partName ? shapesOf(partName) : [];
        },
        previewBuilds,
        previewError,
        runCommand: (command: string, args?: unknown[]) => runRibbon(command, args ?? []),
        notes: () => notes,
        previewBytes: () => (rawPreviewBytes ? rawPreviewBytes.slice(0) : null),
        modelXml,
      }),
    [activeSlide, notes, previewBuilds, previewError, runRibbon, shapesOf, slides],
  );

  const totalBlocks = useMemo(
    () => (slides ?? []).reduce((total, item) => total + item.blocks.length, 0),
    [slides],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OfficeEditorToolbar
        busy={busy}
        dirty={dirty}
        status={status}
        onSave={() => void save()}
        onReload={() => {
          void loadDocument().catch((error) => setStatus(`重新加载失败：${String(error)}`));
        }}
        onExit={onExit}
        confirmExit={() => !dirty || window.confirm("有未保存的修改，确定退出编辑吗？")}
      />
      <OfficeRibbon
        style={pptxRibbonStyle(shape)}
        run={runRibbon}
        tabs={PPTX_RIBBON_TABS}
        // 选中表格才出「表格」上下文标签（与 Word/WPS 的表格工具同一做法）
        inTable={shape?.kind === "graphicFrame"}
      />
      {writeBlocked ? (
        <div className="border-b border-border bg-surface px-3 py-3 text-xs">
          <div className="pb-1 font-medium">这份演示文稿现在不能应用内编辑</div>
          <div className="text-foreground-subtle">{writeBlocked}</div>
        </div>
      ) : null}
      <div className="border-b border-border bg-surface px-3 py-1.5 text-[11px] text-foreground-subtle">
        左边选页、中间点形状拖动或拉角缩放、右边改格式；
        <b>版式、图片、动画、母版、备注原样保留</b>（只重写改过的那几页 XML）。
      </div>

      {slides === null ? (
        <div className="flex flex-1 items-center justify-center text-xs text-foreground-subtle">
          正在打开演示文稿…
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1">
          {thumbsOpen ? (
            <PptxSlideThumbnails
              slides={slides}
              preview={preview}
              activeSlide={activeSlide}
              busy={busy}
              onSelectSlide={(index) => {
                setActiveSlide(index);
                setActiveShape(null);
                setEditing(null);
              }}
              onAdd={() => void addSlideAction()}
              onDuplicate={(partName) => void duplicateSlideAction(partName)}
              onDelete={(partName) => void deleteSlideAction(partName)}
              onMove={(partName, to) => void moveSlideAction(partName, to)}
              onCollapse={() => setThumbsOpen(false)}
            />
          ) : (
            <div className="flex w-6 shrink-0 flex-col items-center border-r border-border pt-1">
              <button
                type="button"
                data-pptx-thumbs-open
                className="rounded px-1 text-foreground-subtle hover:text-foreground"
                onClick={() => setThumbsOpen(true)}
                title="展开幻灯片缩略图"
              >
                ›
              </button>
            </div>
          )}
          {/* 中：画布 */}
          {slide ? (
            // minWidth:0 必须写死：画布里的页面是按"框宽"算大小的，列要是被内容撑宽了，
            // 就会变成 页面变大 → 列变宽 → 页面更大 的正反馈（真机实测：滚轮放大一次页面涨到 27794px）
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col bg-background px-2 py-2"
              style={{ minWidth: 0 }}
            >
              <PptxSlideCanvas
                preview={preview}
                pageIndex={preview.pageIndexOf(slide.partName, activeSlide)}
                partName={slide.partName}
                shapes={shapes}
                activeShape={activeShape}
                onSelect={setActiveShape}
                onCommitBounds={(name, bounds) => setShapeBounds(slide.partName, name, bounds)}
                onRequestText={beginTextEdit}
                onSelectCell={(table, row, col) =>
                  setCellRange({ table, row0: row, col0: col, row1: row, col1: col })
                }
                onExtendCell={(table, row, col) =>
                  setCellRange((current) =>
                    current && current.table === table
                      ? { ...current, row1: row, col1: col }
                      : current,
                  )
                }
                cellRange={cellRange}
                onEditCell={beginCellEdit}
                renderKey={revision}
                editing={editing}
                onEditingText={(text) =>
                  setEditing((current) => (current ? { ...current, text } : current))
                }
                onEditingCommit={commitTextEdit}
                onEditingCancel={() => setEditing(null)}
                zoom={zoom}
                onZoomChange={setZoom}
                onOpenFormatPane={() => setFormatPane(true)}
              />
            </div>
          ) : null}
          {/* 右：任务窗格——窄容器里浮在画布上，宽容器里占布局（不然画布会被挤到 100 多像素） */}
          {formatPane ? (
            <PptxFormatPane
              shape={shape}
              slide={slide}
              shapes={shapes}
              activeShape={activeShape}
              floating={paneFloating}
              onSelectShape={setActiveShape}
              onClose={() => setFormatPane(false)}
              onBounds={(bounds) =>
                slide && shape && setShapeBounds(slide.partName, shape.name, bounds)
              }
              onFormat={(format) =>
                slide && shape && setShapeFormat(slide.partName, shape.name, format)
              }
              onParagraph={(format) =>
                slide && shape && setShapeParagraph(slide.partName, shape.name, format)
              }
              onMoveZ={(direction) =>
                slide && shape && moveShape(slide.partName, shape.name, direction)
              }
              onDuplicate={() => slide && shape && duplicateShape(slide.partName, shape.name)}
              onDelete={() => {
                if (slide && shape) removeShape(slide.partName, shape.name);
                setActiveShape(null);
              }}
              onAddTextBox={() => slide && addTextBox(slide.partName)}
              tableGrid={tableGrid}
              onTableGrid={(on) => runRibbon(on ? "pptxTableGridOn" : "pptxTableGridOff")}
              notes={notes}
              onNotesChange={(lines) => {
                if (slide) void saveNotes(slide.partName, lines);
              }}
              registerBlockRef={registerRef}
              onChangeBlock={(index, lines) => slide && setBlockLines(slide.partName, index, lines)}
            />
          ) : null}
        </div>
      )}
      <div className="border-t border-border px-3 py-1 text-[11px] text-foreground-subtlest">
        共 {slides?.length ?? 0} 页 / {totalBlocks} 个文本块 / {shapes.length} 个形状（当前页）
      </div>
    </div>
  );
}
