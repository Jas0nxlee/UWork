/**
 * 选中形状的**选框 + 八个缩放手柄 + 旋转手柄**。
 *
 * ⚠️ **必须返回 Fragment，不能套 wrapper**：早先我给这层套了一个 `<div>`，DOM 结构变了、
 * 指针事件的落点跟着变 —— 结果"从中心拖动"抓到了手柄，"移动"变成了"拉扁"
 * （形状被压到最小高度）。现在 DOM 结构与内联写法**逐节点一致**，只是把代码搬了个家。
 *
 * 坐标口径：全部是**交互层的显示像素**（`toPx` 换算），与命中测试同一套；
 * 形状带 `rot` 时选框整体 `rotate()`，与画面里的形状方向一致。
 */
import {
  ROTATE_OFFSET_PX,
  rotationHandleSpot,
  type CanvasBox,
  type CanvasCorner,
  type CanvasViewport,
} from "./pptCanvasGeometry.js";

export interface PptxSelectionOverlayProps {
  box: CanvasBox;
  viewport: CanvasViewport;
  /** 八个缩放手柄（显示像素，已夹取）。 */
  handles: Array<{ corner: CanvasCorner; left: number; top: number; cursor: string }>;
  /** 旋转中的实时角度（度）；不在旋转时为空。 */
  rotateDraft: number | null;
  /** 选中形状的名字（写在选框上，界面/自动化都靠它读"当前选中谁"）。 */
  selectionName: string;
  toPx: (emu: number) => number;
  moving: boolean;
  canRotate: boolean;
  onResizeStart: (event: React.PointerEvent<HTMLSpanElement>, corner: CanvasCorner) => void;
  onRotateStart: (event: React.PointerEvent<HTMLSpanElement>) => void;
}

export function PptxSelectionOverlay({
  box,
  viewport,
  handles,
  rotateDraft,
  selectionName,
  toPx,
  moving,
  canRotate,
  onResizeStart,
  onRotateStart,
}: PptxSelectionOverlayProps) {
  const spot = canRotate ? rotationHandleSpot(box, viewport) : null;
  return (
    <>
      <div
        data-pptx-canvas-selection={selectionName}
        className="border-2 border-sky-400"
        style={{
          position: "absolute",
          left: toPx(box.x),
          top: toPx(box.y),
          width: toPx(box.width),
          height: toPx(box.height),
          // 形状带 rot 时选框也要转，否则拖动/手柄与画面对不上
          transform: `rotate(${rotateDraft ?? box.rotation ?? 0}deg)`,
          cursor: moving ? "grabbing" : "grab",
        }}
      />
      {spot ? (
        <>
          <span
            style={{
              position: "absolute",
              pointerEvents: "none",
              left: spot.left + 5.5,
              top: spot.top + 12,
              width: 1,
              height: ROTATE_OFFSET_PX - 12,
              background: "rgb(14,165,233)",
            }}
          />
          <span
            data-pptx-canvas-handle="rotate"
            className="rounded-full border border-sky-500 bg-white"
            style={{
              position: "absolute",
              width: 12,
              height: 12,
              cursor: "grab",
              left: spot.left,
              top: spot.top,
            }}
            onPointerDown={onRotateStart}
          />
        </>
      ) : null}
      {handles.map(({ corner, left, top, cursor }) => (
        <span
          key={corner}
          data-pptx-canvas-handle={corner}
          className="rounded-full border border-sky-500 bg-white"
          style={{ position: "absolute", width: 12, height: 12, cursor, left, top }}
          onPointerDown={(event) => onResizeStart(event, corner)}
        />
      ))}
    </>
  );
}
