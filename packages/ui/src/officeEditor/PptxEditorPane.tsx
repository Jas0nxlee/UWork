/**
 * PPTX 的**编辑位**（幻灯片列表 + 形状列表 + 文字编辑 + 形状检查器）。
 *
 * 定位（写在界面上，不假装）：这是**保真补丁编辑器**，不是 WYSIWYG 排版器——
 * 拖拽排版、动画、母版没有；但"改文字/改文字格式/挪位置与大小/调层级/复制删除形状/
 * 新建文本框/幻灯片增删排序"都能做，而且**只改必要的那几个部件**：图片、母版、版式、
 * 动画、备注逐字节保留（由 pptxValidate 的"未编辑部件必须逐字节一致"盯着）。
 * 不用富文本编辑器的理由见 specs/office-editors-triad.md：可用的 OSS pptx 编辑器只有 AGPL 的 PPTist。
 */
import type { IFileService } from "@zcode/services";
import { useEffect, useMemo, useState } from "react";
import { OfficeEditorToolbar } from "./OfficeEditorToolbar.js";
import { ShapeInspector } from "./PptxShapeInspector.js";
import { usePptxDocument } from "./usePptxDocument.js";

export interface PptxEditorPaneProps {
  fileService: IFileService;
  path: string;
  remote?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onExit?: () => void;
}

const smallButton =
  "rounded border border-border px-2 py-1 text-[11px] hover:border-accent disabled:opacity-40";

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

  useEffect(() => {
    setActiveSlide(0);
    setActiveShape(null);
  }, [path]);

  const slide = slides?.[activeSlide];
  const blocks = useMemo(() => slide?.blocks ?? [], [slide]);
  const shapes = useMemo(
    () => (slide ? shapesOf(slide.partName) : []),
    // shapesOf 读的是**当前 XML**（不是 React state）：改动靠 revision 触发重算
    [shapesOf, slide, revision],
  );
  const shape = shapes.find((item) => item.name === activeShape) ?? null;

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
      {writeBlocked ? (
        <div className="border-b border-border bg-surface px-3 py-3 text-xs">
          <div className="pb-1 font-medium">这份演示文稿现在不能应用内编辑</div>
          <div className="text-foreground-subtle">{writeBlocked}</div>
        </div>
      ) : null}
      <div className="border-b border-border bg-surface px-3 py-2 text-[11px] text-foreground-subtle">
        改文字 / 格式 / 位置大小 / 层级 / 形状增删 / 幻灯片增删排序都可以做；
        <b>版式、图片、动画、母版、备注原样保留</b>（只重写改过的那几页 XML）。
        拖拽排版与动画不在范围内——那是 WYSIWYG 排版器的活。
      </div>

      {slides === null ? (
        <div className="flex flex-1 items-center justify-center text-xs text-foreground-subtle">
          正在打开演示文稿…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左：幻灯片列表 + 幻灯片级操作 */}
          <div className="flex w-36 shrink-0 flex-col border-r border-border">
            <div className="flex flex-wrap gap-1 border-b border-border p-1">
              <button
                type="button"
                data-slide-add
                className={smallButton}
                disabled={busy}
                onClick={() => void addSlideAction()}
              >
                + 新页
              </button>
              <button
                type="button"
                data-slide-duplicate
                className={smallButton}
                disabled={busy || !slide}
                onClick={() => slide && void duplicateSlideAction(slide.partName)}
              >
                复制
              </button>
              <button
                type="button"
                data-slide-delete
                className={smallButton}
                disabled={busy || !slide || slides.length <= 1}
                onClick={() => slide && void deleteSlideAction(slide.partName)}
              >
                删除
              </button>
              <button
                type="button"
                data-slide-up
                className={smallButton}
                disabled={busy || activeSlide === 0}
                onClick={() => slide && void moveSlideAction(slide.partName, activeSlide - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                data-slide-down
                className={smallButton}
                disabled={busy || activeSlide >= slides.length - 1}
                onClick={() => slide && void moveSlideAction(slide.partName, activeSlide + 1)}
              >
                ↓
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {slides.map((item, index) => (
                <button
                  key={item.partName}
                  type="button"
                  data-pptx-slide={index + 1}
                  className={`block w-full px-2 py-2 text-left text-xs ${
                    index === activeSlide
                      ? "bg-accent/20 font-medium text-accent"
                      : "text-foreground hover:bg-surface"
                  }`}
                  onClick={() => {
                    setActiveSlide(index);
                    setActiveShape(null);
                  }}
                >
                  <span className="pr-1 text-foreground-subtle">第 {index + 1} 页</span>
                  <div className="truncate text-[11px] text-foreground-subtle">
                    {item.blocks
                      .flatMap((block) => block.lines)
                      .join(" ")
                      .slice(0, 20) || "—"}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 右：形状列表 + 文字编辑 */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
            {slide ? (
              <div className="pb-2">
                <div className="flex items-center gap-2 pb-1">
                  <span className="text-[11px] text-foreground-subtle">
                    这一页的形状（点一个来改它的属性）：
                  </span>
                  <button
                    type="button"
                    data-shape-add-textbox
                    className={smallButton}
                    onClick={() => addTextBox(slide.partName)}
                  >
                    + 新建文本框
                  </button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {shapes.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      data-pptx-shape={item.name}
                      className={`rounded border px-2 py-1 text-[11px] ${
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
            {blocks.length === 0 ? (
              <div className="py-6 text-center text-xs text-foreground-subtle">
                这一页没有可编辑的文字（可能整页都是图片）
              </div>
            ) : (
              blocks.map((block) => (
                <div key={block.index} className="pb-3">
                  <div className="pb-1 text-[11px] text-foreground-subtle">
                    文本 {block.index + 1} · {block.label}
                  </div>
                  <textarea
                    data-pptx-block={`${slide?.partName}#${block.index}`}
                    className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-[13px] leading-relaxed"
                    rows={Math.min(12, Math.max(2, block.lines.length + 1))}
                    value={block.lines.join("\n")}
                    onChange={(event) => {
                      if (!slide) return;
                      setBlockLines(slide.partName, block.index, event.target.value.split("\n"));
                    }}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      )}
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
      ) : null}
      <div className="border-t border-border px-3 py-1 text-[11px] text-foreground-subtlest">
        共 {slides?.length ?? 0} 页 / {totalBlocks} 个文本块 / {shapes.length} 个形状（当前页）
      </div>
    </div>
  );
}
