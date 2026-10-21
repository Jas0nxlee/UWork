/**
 * 画布上的**叠加层**：选中框、八个缩放手柄、旋转手柄、选中单元格的细框、就地改字的编辑层。
 *
 * ⚠️ **返回 Fragment，不套 wrapper**：套一层 div 会改 DOM 结构 ⇒ 指针事件落点跟着变
 * （实测：给这层套 div 之后"从中心拖动"抓到了手柄、"移动"变成"拉扁"）。这里只是把代码搬了个家。
 */
import { PptxSelectionOverlay } from "./PptxSelectionOverlay.js";
import { PptxTextEditor } from "./PptxTextEditor.js";
import type { CanvasBox, CanvasCorner, CanvasViewport } from "./pptCanvasGeometry.js";
import type { ShapeRunFormat } from "./pptShapes.js";

export interface PptxCanvasOverlaysProps {
  activeShape: string | null;
  activeBox: CanvasBox | null;
  handleSpots: Array<{ corner: CanvasCorner; left: number; top: number; cursor: string }>;
  viewport: CanvasViewport;
  rotateDraft: number | null;
  toPx: (emu: number) => number;
  moving: boolean;
  onResizeStart: (event: React.PointerEvent<HTMLSpanElement>, corner: CanvasCorner) => void;
  onRotateStart: (event: React.PointerEvent<HTMLSpanElement>) => void;
  /** 选中单元格的细框（有才画）。 */
  activeCellBox: { key: string; box: CanvasBox } | null;
  /** 就地改字：编辑层盖的框（单元格编辑时是那一格，否则是形状）。 */
  editing: boolean;
  editingBox: CanvasBox | null;
  editingText: string;
  editingFormat: ShapeRunFormat;
  editingAlign?: "left" | "center" | "right" | "justify";
  scale: number;
  onEditingText: (text: string) => void;
  onEditingCommit: () => void;
  onEditingCancel: () => void;
}

export function PptxCanvasOverlays(props: PptxCanvasOverlaysProps) {
  const editSurface = props.editing ? (props.editingBox ?? props.activeBox) : null;
  return (
    <>
      {editSurface ? (
        <PptxTextEditor
          box={editSurface}
          scale={props.scale}
          format={props.editingFormat}
          align={props.editingAlign}
          value={props.editingText}
          onChange={props.onEditingText}
          onCommit={props.onEditingCommit}
          onCancel={props.onEditingCancel}
        />
      ) : null}
      {props.activeCellBox ? (
        <div
          data-pptx-canvas-cell={props.activeCellBox.key}
          className="border-2 border-sky-500 bg-sky-500/10"
          style={{
            position: "absolute",
            pointerEvents: "none",
            left: props.toPx(props.activeCellBox.box.x),
            top: props.toPx(props.activeCellBox.box.y),
            width: props.toPx(props.activeCellBox.box.width),
            height: props.toPx(props.activeCellBox.box.height),
          }}
        />
      ) : null}
      {props.activeBox && !props.editing ? (
        <PptxSelectionOverlay
          box={props.activeBox}
          viewport={props.viewport}
          handles={props.handleSpots}
          rotateDraft={props.rotateDraft}
          toPx={props.toPx}
          moving={props.moving}
          canRotate
          selectionName={props.activeShape ?? ""}
          onResizeStart={props.onResizeStart}
          onRotateStart={props.onRotateStart}
        />
      ) : null}
    </>
  );
}
