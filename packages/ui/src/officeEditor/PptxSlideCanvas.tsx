/**
 * PPT 编辑位的**幻灯片画布**（PowerPoint 形态：页面居中、可缩放、点选后可拖可拉角）。
 *
 * **两套坐标，别混**：
 *   - XML 里（`a:off` / `a:ext`）是 **EMU**（1 厘米 = 360000 EMU）；
 *   - 渲染器给的是 **96 dpi 像素**（`pageSize` 就是 960×720，因为一页 9144000 EMU = 10 英寸）；
 *     换算是固定的 `1 px = 9525 EMU`。本组件内部一律用 EMU 记账（读渲染器几何立刻 ×9525），
 *     只在画到屏幕上时才换回像素。
 *
 * **几何相关的 CSS 一律 inline style**：检查脚手架页面里没有 Tailwind，用 class 写
 * `relative`/`overflow-hidden`/`origin-top-left` 会在那儿全部失效（实测踩过：缩放层绕中心放大、
 * 盖住整个编辑位，左侧列表点不动）。样式（颜色/边框）照旧用 class。
 *
 * **点选名单以本页 XML 为准**：渲染器还会画从版式/母版继承来的形状，它们不在本页 XML 里、
 * 改了也写不回去，所以不进名单——宁可点不到，不能"拖了半天没反应"。
 */
import { useCallback, useRef } from "react";
import {
  EMU_PER_PX,
  handleSpots,
  isOffPage,
  PAGE_MARGIN_PX,
  type CanvasBox,
} from "./pptCanvasGeometry.js";
import { canvasHint } from "./pptCanvasHint.js";
import { PptxCanvasZoomBar } from "./PptxCanvasZoomBar.js";
import { PptxCanvasContextMenu } from "./PptxCanvasContextMenu.js";
import { useCanvasCells } from "./useCanvasCells.js";
import { useCanvasContextMenu } from "./useCanvasContextMenu.js";
import { useCanvasDrag } from "./useCanvasDrag.js";
import { useCanvasHitTest } from "./useCanvasHitTest.js";
import { PptxCanvasOverlays } from "./PptxCanvasOverlays.js";
import { useCanvasViewport } from "./useCanvasViewport.js";
import { usePptxPageRender } from "./usePptxPageRender.js";
import type { PptxSlideCanvasProps } from "./pptxSlideCanvasProps.js";

export function PptxSlideCanvas({
  preview,
  pageIndex,
  partName,
  shapes,
  activeShape,
  onSelect,
  onCommitBounds,
  onRequestText,
  onSelectCell,
  onEditCell,
  cellRange,
  onExtendCell,
  renderKey,
  zoom,
  onZoomChange,
  onOpenFormatPane,
  onContextAction,
  editing,
  onEditingText,
  onEditingCommit,
  onEditingCancel,
}: PptxSlideCanvasProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const view = useCanvasViewport({
    frameRef,
    pageWidth: preview.pageWidth,
    pageHeight: preview.pageHeight,
    zoom,
    onZoomChange,
  });
  const { scale, pageDisplayWidth, pageDisplayHeight, toPx, toEmu, viewport, viewportOf } = view;
  // 画当前页 + 量出渲染器实测的形状框（都在这个 hook 里，见它的注释）
  const { hostRef, measured } = usePptxPageRender({ preview, pageIndex, partName, renderKey });
  const { hitCell, boxOfCell, boxesOfRange } = useCanvasCells({
    preview,
    pageIndex,
    shapes,
    layerRef,
    scale,
    toPx,
  });

  /** 拖动中的实时几何（state + ref 双份，见 useCanvasDrag 的注释）。 */
  const draftRef = useRef<{ name: string; box: CanvasBox } | null>(null);

  /** 形状的显示几何：XML 显式几何优先，否则用渲染器量到的；都没有 = 不可拖。 */
  const boxOf = useCallback(
    (name: string): CanvasBox | null => {
      const live = draftRef.current;
      if (live?.name === name) return live.box;
      const shape = shapes.find((item) => item.name === name);
      if (!shape) return null;
      if (shape.bounds.explicit) {
        return {
          x: shape.bounds.x,
          y: shape.bounds.y,
          width: shape.bounds.width,
          height: shape.bounds.height,
          ...(shape.bounds.rotation === undefined ? {} : { rotation: shape.bounds.rotation }),
        };
      }
      return measured[name] ?? null;
    },
    [measured, shapes],
  );

  const activeBox = activeShape ? boxOf(activeShape) : null;
  /** 正在编辑的形状（拿它的格式去渲染编辑层）。 */
  const shapeOfEditing = editing
    ? (shapes.find((item) => item.name === editing.shape) ?? null)
    : null;
  const activeShapeKnown = activeShape ? shapes.some((item) => item.name === activeShape) : false;
  const { hitTest, onTableEdge } = useCanvasHitTest({ layerRef, shapes, boxOf, scale, toPx });
  const { menu, setMenu, onContextMenu } = useCanvasContextMenu({ frameRef, hitTest, onSelect });
  const { drag, rotateDraft, onPointerDown, onPointerMove, onPointerUp, startRotate, startResize } =
    useCanvasDrag({
      layerRef,
      scale,
      viewport,
      toPx,
      toEmu,
      activeShape,
      editing: editing !== null,
      boxOf,
      hitTest,
      hitCell,
      onTableEdge,
      onSelect,
      onSelectCell,
      onExtendCell,
      onCommitBounds,
      draftRef,
    });
  // 菜单自己吃掉指针：点画布任意处先把手菜单收起来
  const onLayerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    setMenu(null);
    onPointerDown(event);
  };

  // 选区框：编辑某一格时只画那一格；否则画整片选区（1×1 就是原来那一格）
  const editingCellBox = editing?.cell
    ? boxOfCell({ table: editing.shape, ...editing.cell })
    : null;
  const cellBoxes = editingCellBox
    ? [{ ...editingCellBox, anchor: true }]
    : boxesOfRange(cellRange ?? null);
  const handleSpotList = activeBox ? handleSpots(activeBox, viewport) : [];
  const offPage = activeBox ? isOffPage(activeBox, viewport) : false;
  const hint = canvasHint({ activeShape, activeBox, known: activeShapeKnown, offPage });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={frameRef}
        className="rounded border border-border bg-surface/40"
        style={{
          position: "relative",
          overflow: "auto",
          // 吃满这一列剩下的高度：页面因此可以"上下居中"，面板开合时也会自动重新适应
          flex: "1 1 auto",
          minHeight: 160,
          display: "flex",
          padding: PAGE_MARGIN_PX,
          // 框宽只由列宽决定，绝不被里面的页面撑宽（否则会正反馈放大，见 PptxEditorPane 的注释）
          width: "100%",
          maxWidth: "100%",
          boxSizing: "border-box",
        }}
        data-pptx-canvas-frame
        data-pptx-canvas-ready={scale > 0 ? "true" : "false"}
        data-pptx-canvas-scale={scale}
        data-pptx-canvas-zoom={zoom}
        data-pptx-canvas-page-width={Math.round((preview.pageWidth || 0) * EMU_PER_PX)}
        data-pptx-canvas-page-height={Math.round((preview.pageHeight || 0) * EMU_PER_PX)}
      >
        <div
          // margin:auto＝页面在框里居中；比容器大时还能滚到两头（flex 居中会把上/左边切掉）
          style={{
            position: "relative",
            margin: "auto",
            flex: "0 0 auto",
            width: pageDisplayWidth,
            height: pageDisplayHeight,
          }}
          data-pptx-canvas-page
        >
          {/* 裁剪层：只把**渲染出来的这一页**裁在页面范围内（交互层不在里面，手柄要能落在页面外） */}
          <div
            style={{ position: "absolute", inset: 0, overflow: "hidden" }}
            data-pptx-canvas-surface
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: preview.pageWidth || 0,
                height: preview.pageHeight || 0,
                transformOrigin: "top left",
                transform: `scale(${scale})`,
              }}
            >
              <div
                ref={hostRef}
                className="pointer-events-none"
                style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
                data-pptx-canvas-host
              />
            </div>
          </div>
          {/* 交互层：全在"显示像素"这一层，EMU↔px 的换算只发生在 toEmu/toPx 里；不裁剪 */}
          {scale > 0 ? (
            <div
              ref={layerRef}
              className="cursor-default"
              style={{ position: "absolute", inset: 0 }}
              data-pptx-canvas-layer
              onPointerDown={onLayerPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onContextMenu={onContextMenu}
              onDoubleClick={(event) => {
                if (editing) return;
                const cell = hitCell(event.clientX, event.clientY);
                if (cell) {
                  onSelect(cell.table);
                  onEditCell?.(cell.table, cell.row, cell.col);
                  return;
                }
                const name = hitTest(event.clientX, event.clientY);
                if (name && onRequestText) onRequestText(name);
              }}
            >
              <PptxCanvasOverlays
                activeShape={activeShape}
                activeBox={activeBox}
                handleSpots={handleSpotList}
                viewport={viewportOf(activeBox ?? { x: 0, y: 0, width: 0, height: 0 })}
                rotateDraft={rotateDraft}
                toPx={toPx}
                moving={drag?.mode === "move"}
                onResizeStart={startResize}
                onRotateStart={startRotate}
                cellBoxes={cellBoxes}
                editing={editing !== null}
                editingBox={
                  editing?.cell
                    ? (boxOfCell({ table: editing.shape, ...editing.cell })?.box ?? null)
                    : null
                }
                editingText={editing?.text ?? ""}
                editingFormat={shapeOfEditing?.runFormat ?? {}}
                editingAlign={shapeOfEditing?.textBodies[0]?.[0]?.align}
                scale={scale}
                onEditingText={onEditingText}
                onEditingCommit={onEditingCommit}
                onEditingCancel={onEditingCancel}
              />
            </div>
          ) : null}
          <PptxCanvasContextMenu
            menu={menu}
            inTable={
              (shapes.find((item) => item.name === menu?.name)?.kind ?? "") === "graphicFrame"
            }
            onClose={() => setMenu(null)}
            onOpenFormatPane={onOpenFormatPane}
            onDuplicate={() => menu && onContextAction?.("duplicate", menu.name)}
            onDelete={() => menu && onContextAction?.("delete", menu.name)}
            onMoveZ={(direction) => menu && onContextAction?.(`move-${direction}`, menu.name)}
          />
          {preview.error ? (
            <div
              className="absolute inset-0 flex items-center justify-center px-4 text-center text-[11px] text-foreground-subtle"
              style={{ position: "absolute", inset: 0 }}
            >
              这一页渲染不出来（{preview.error.slice(0, 60)}）——仍可以用右侧窗格与形状列表改。
            </div>
          ) : null}
        </div>
      </div>
      {/* 底部一条：左边是选中说明，右边是 PowerPoint 那套缩放控件 */}
      <div className="flex items-center justify-between gap-2 pt-1.5">
        <span className="truncate text-[10px] text-foreground-subtlest">{hint}</span>
        <PptxCanvasZoomBar
          zoom={zoom}
          onZoomChange={onZoomChange}
          onOpenFormatPane={onOpenFormatPane}
        />
      </div>
    </div>
  );
}
