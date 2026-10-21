/**
 * 画布上的**命中测试**：点到了哪个形状、是不是落在表格的"边框带"上。
 *
 * 单独成文件的原因：画布那个组件要守 400 行；这块也确实是自成一摊的纯命中。
 *
 * 两条实测出来的口径：
 *   - 名单以**本页 XML** 为准（渲染器还会画从版式/母版继承来的形状，那些改了也写不回去）；
 *   - 表格的框就是单元格的并集，**靠边 TABLE_EDGE_PX 以内算"抓表格"**，否则整张表没有能拖的地方。
 */
import { useCallback } from "react";
import { nearBoxEdge, TABLE_EDGE_PX, type CanvasBox } from "./pptCanvasGeometry.js";

export function useCanvasHitTest(input: {
  layerRef: React.RefObject<HTMLDivElement | null>;
  shapes: readonly { name: string }[];
  boxOf: (name: string) => CanvasBox | null;
  scale: number;
  toPx: (emu: number) => number;
}) {
  const { layerRef, shapes, boxOf, scale, toPx } = input;

  /** 命中哪个形状（从上层往下找；坐标用**交互层**算，容器滚动也不跑偏）。 */
  const hitTest = useCallback(
    (clientX: number, clientY: number): string | null => {
      const layer = layerRef.current;
      if (!layer || scale <= 0) return null;
      const rect = layer.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      for (const shape of [...shapes].reverse()) {
        const box = boxOf(shape.name);
        if (!box) continue;
        const left = toPx(box.x);
        const top = toPx(box.y);
        const width = toPx(box.width);
        const height = toPx(box.height);
        if (width <= 2 || height <= 2) continue;
        if (x >= left && x <= left + width && y >= top && y <= top + height) return shape.name;
      }
      return null;
    },
    [boxOf, layerRef, scale, shapes, toPx],
  );

  /**
   * 指针是不是落在表格的**边框带**上（是的话按"拖这张表"处理，不按"选这一格"）。
   *
   * 带宽 = 表边往里最多 `TABLE_EDGE_PX`，且**不超过格子的三分之一**：这样不管画布缩放到多小
   * （fit-to-window 时格子可能只有 6~7px 高），"格子中间"永远还是选格、"表边那一圈"永远是抓表。
   * 早先按"格子小于 N 像素就当小表、按哪儿都能抓"来做，缩放下会把普通表格误判成小表✗
   * （实测：0.2 缩放时 3×3 的格子只有 6.7px → 拖选一片完全失效）。
   */
  const onTableEdge = useCallback(
    (clientX: number, clientY: number, tableName: string, cell: { box: CanvasBox }): boolean => {
      const layer = layerRef.current;
      const frame = boxOf(tableName);
      if (!layer || !frame || scale <= 0) return false;
      const rect = layer.getBoundingClientRect();
      const left = toPx(frame.x);
      const top = toPx(frame.y);
      const band = Math.max(
        2,
        Math.min(TABLE_EDGE_PX, Math.min(toPx(cell.box.width), toPx(cell.box.height)) / 3),
      );
      return nearBoxEdge(
        { x: clientX - rect.left, y: clientY - rect.top },
        { left, top, right: left + toPx(frame.width), bottom: top + toPx(frame.height) },
        band,
      );
    },
    [boxOf, layerRef, scale, toPx],
  );

  return { hitTest, onTableEdge };
}
