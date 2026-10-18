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
import { ShapeInspector } from "./PptxShapeInspector.js";
import { PptxSlideCanvas } from "./PptxSlideCanvas.js";
import { PptxSlideThumbnails } from "./PptxSlideThumbnails.js";
import { PptxTextBlocks } from "./PptxTextBlocks.js";
import { PPTX_RIBBON_TABS } from "./pptxRibbonTabs.js";
import { pptxRibbonStyle, runPptxRibbonCommand } from "./pptxRibbonRun.js";
import { shapeLines } from "./pptShapes.js";
import { usePptxDocument } from "./usePptxDocument.js";
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
    previewBytes,
    setBlockLines,
    shapesOf,
    setShapeBounds,
    setShapeFormat,
    setShapeParagraph,
    moveShape,
    duplicateShape,
    removeShape,
    addTextBox,
    addSlideAction,
    duplicateSlideAction,
    deleteSlideAction,
    moveSlideAction,
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
  /** 一份文件只解析一次的预览文档：画布与左栏缩略图共用。 */
  const preview = usePptxPreview(previewBytes);
  /** 文本框的 DOM 引用：画布双击"就地改字"要能把焦点移到对应的文本框上。 */
  const blockRefs = useRef(new Map<number, HTMLTextAreaElement>());

  useEffect(() => {
    setActiveSlide(0);
    setActiveShape(null);
    setFormatPane(false);
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

  const registerRef = useCallback((index: number, element: HTMLTextAreaElement | null) => {
    if (element) blockRefs.current.set(index, element);
    else blockRefs.current.delete(index);
  }, []);

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
      const element = blockRefs.current.get(block.index);
      element?.focus();
      element?.scrollIntoView({ block: "nearest" });
      if (matched) element?.select();
      else setStatus(`已在右侧打开第 ${block.index + 1} 个文本框（「${name}」没有独立文字块）`);
    },
    [setStatus, shapes, slide],
  );

  /** 功能区命令 → 编辑位已有的操作（命令清单在 pptxRibbonTabs.ts，两边一起改）。 */
  const runRibbon = useStableCallback(
    (command: string, args?: unknown[]) => {
      const partName = slide?.partName ?? null;
      runPptxRibbonCommand(command, args ?? [], {
        partName,
        shape,
        slideIndex: activeSlide,
        slideCount: slides?.length ?? 0,
        addSlide: () => void addSlideAction(),
        duplicateSlide: () => partName && void duplicateSlideAction(partName),
        deleteSlide: () => partName && void deleteSlideAction(partName),
        moveSlide: (to) => partName && void moveSlideAction(partName, to),
        addTextBox: () => partName && addTextBox(partName),
        duplicateShape: () => partName && shape && duplicateShape(partName, shape.name),
        deleteShape: () => partName && shape && removeShape(partName, shape.name),
        moveShape: (direction) => partName && shape && moveShape(partName, shape.name, direction),
        setFormat: (format) => partName && shape && setShapeFormat(partName, shape.name, format),
        setParagraph: (format) =>
          partName && shape && setShapeParagraph(partName, shape.name, format),
        setZoom,
        note: setStatus,
      });
    },
    [
      activeSlide,
      addSlideAction,
      addTextBox,
      deleteSlideAction,
      duplicateShape,
      duplicateSlideAction,
      moveShape,
      moveSlideAction,
      removeShape,
      setShapeFormat,
      setShapeParagraph,
      setStatus,
      shape,
      slide,
      slides,
    ],
  );

  // 与 Excel/Word 编辑位同款：把"看状态"的小口子挂到 globalThis，真机排查与自动化都用它
  useEffect(() => {
    const global = globalThis as Record<string, unknown>;
    global.__pptxPane = {
      slideCount: () => slides?.length ?? 0,
      shapeNames: () =>
        slides?.[activeSlide]
          ? shapesOf(slides[activeSlide].partName).map((item) => item.name)
          : [],
      shapeBounds: (name: string) => {
        const partName = slides?.[activeSlide]?.partName;
        if (!partName) return null;
        const found = shapesOf(partName).find((item) => item.name === name);
        return found ? found.bounds.width : null;
      },
      /** 形状的完整几何（EMU）：画布断言按它算"该点在哪儿"。 */
      shapeBox: (name: string) => {
        const partName = slides?.[activeSlide]?.partName;
        if (!partName) return null;
        const found = shapesOf(partName).find((item) => item.name === name);
        return found ? { ...found.bounds } : null;
      },
      /** 画布状态：渲染出来了没 / 选中哪个形状 / 选框与手柄在不在。 */
      canvas: () => {
        const frame = document.querySelector("[data-pptx-canvas-frame]");
        if (!frame) return null;
        const selection = document.querySelector("[data-pptx-canvas-selection]");
        const host = frame.querySelector("[data-pptx-canvas-host]");
        const layer = frame.querySelector("[data-pptx-canvas-layer]");
        const rect = (node: Element | null) => {
          if (!node) return null;
          const box = node.getBoundingClientRect();
          return { left: box.left, top: box.top, width: box.width, height: box.height };
        };
        return {
          ready: frame.getAttribute("data-pptx-canvas-ready") === "true",
          scale: Number(frame.getAttribute("data-pptx-canvas-scale") ?? 0),
          zoom: Number(frame.getAttribute("data-pptx-canvas-zoom") ?? 0),
          pageWidth: Number(frame.getAttribute("data-pptx-canvas-page-width") ?? 0),
          renderedNodes: host ? host.childElementCount : 0,
          selected: selection?.getAttribute("data-pptx-canvas-selection") ?? null,
          handles: frame.querySelectorAll("[data-pptx-canvas-handle]").length,
          frame: rect(frame),
          layer: rect(layer),
          selectionRect: rect(selection),
        };
      },
      /** 左栏缩略图面板的状态（缩略图画出来没、当前页高亮对不对）。 */
      thumbnails: () => {
        const panel = document.querySelector("[data-pptx-slide-panel]");
        if (!panel) return null;
        const items = [...panel.querySelectorAll("[data-pptx-slide]")];
        return {
          count: items.length,
          rendered: items.filter((item) => {
            const host = item.querySelector("[data-pptx-thumb-host]");
            return host ? host.childElementCount > 0 : false;
          }).length,
          active: items.findIndex((item) => item.querySelector("[data-pptx-thumb-host]")),
        };
      },
    };
    return () => {
      if (global.__pptxPane) global.__pptxPane = undefined;
    };
  });

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
      <OfficeRibbon style={pptxRibbonStyle(shape)} run={runRibbon} tabs={PPTX_RIBBON_TABS} />
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
        <div className="flex min-h-0 flex-1">
          <PptxSlideThumbnails
            slides={slides}
            preview={preview}
            activeSlide={activeSlide}
            busy={busy}
            onSelectSlide={(index) => {
              setActiveSlide(index);
              setActiveShape(null);
            }}
            onAdd={() => void addSlideAction()}
            onDuplicate={(partName) => void duplicateSlideAction(partName)}
            onDelete={(partName) => void deleteSlideAction(partName)}
            onMove={(partName, to) => void moveSlideAction(partName, to)}
          />
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
                onRequestText={focusBlockOfShape}
                zoom={zoom}
                onZoomChange={setZoom}
                onOpenFormatPane={() => setFormatPane(true)}
              />
            </div>
          ) : null}
          {/* 右：任务窗格（设置形状格式 / 文本）——默认收起，别把中间的画布挤窄 */}
          {formatPane ? (
            <div
              className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border"
              data-pptx-task-pane
            >
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-[11px] font-medium">设置形状格式</span>
                <button
                  type="button"
                  data-pptx-close-format
                  className="rounded px-1 text-foreground-subtle hover:text-foreground"
                  onClick={() => setFormatPane(false)}
                  title="收起窗格（把画布让出来）"
                >
                  ✕
                </button>
              </div>
              {shape && slide ? (
                <ShapeInspector
                  shape={shape}
                  onBounds={(bounds) => setShapeBounds(slide.partName, shape.name, bounds)}
                  onFormat={(format) => setShapeFormat(slide.partName, shape.name, format)}
                  onParagraph={(format) => setShapeParagraph(slide.partName, shape.name, format)}
                  onMoveZ={(direction) => moveShape(slide.partName, shape.name, direction)}
                  onDuplicate={() => duplicateShape(slide.partName, shape.name)}
                  onDelete={() => {
                    removeShape(slide.partName, shape.name);
                    setActiveShape(null);
                  }}
                />
              ) : (
                <div className="px-3 py-2 text-[11px] text-foreground-subtlest">
                  在画布上点一个形状，或从下面的形状列表里选一个，这里就会出现它的位置、大小与文字格式。
                </div>
              )}
              {slide ? (
                <div className="border-t border-border px-3 py-2">
                  <div className="flex items-center justify-between pb-1">
                    <span className="text-[11px] text-foreground-subtle">
                      这一页的形状（也可以在画布上点）
                    </span>
                    <button
                      type="button"
                      data-shape-add-textbox
                      className="rounded border border-border px-2 py-0.5 text-[11px] hover:border-accent"
                      onClick={() => addTextBox(slide.partName)}
                    >
                      ＋ 文本框
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {shapes.map((item) => (
                      <button
                        key={item.name}
                        type="button"
                        data-pptx-shape={item.name}
                        className={`rounded border px-2 py-0.5 text-[11px] ${
                          item.name === activeShape
                            ? "border-sky-500 bg-sky-500/10 text-sky-200"
                            : "border-border hover:border-accent"
                        }`}
                        onClick={() => setActiveShape(item.name)}
                      >
                        {item.name || "(未命名)"}
                        {item.kind === "pic"
                          ? " ·图片"
                          : item.kind === "graphicFrame"
                            ? " ·表格"
                            : ""}
                      </button>
                    ))}
                    {shapes.length === 0 ? (
                      <span className="text-[11px] text-foreground-subtlest">
                        这一页没有可编辑形状
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="border-t border-border px-3 py-2">
                <div className="pb-1 text-[11px] font-medium">文本</div>
                <PptxTextBlocks
                  slide={slide}
                  registerRef={registerRef}
                  onChange={(index, lines) => {
                    if (slide) setBlockLines(slide.partName, index, lines);
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>
      )}
      <div className="border-t border-border px-3 py-1 text-[11px] text-foreground-subtlest">
        共 {slides?.length ?? 0} 页 / {totalBlocks} 个文本块 / {shapes.length} 个形状（当前页）
      </div>
    </div>
  );
}
