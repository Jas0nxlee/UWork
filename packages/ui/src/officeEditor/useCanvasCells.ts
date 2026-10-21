/**
 * 画布上的**表格单元格索引**：从渲染器的元素里取"表名 + 行列号 + 绝对框"，做命中测试与选中框。
 *
 * 为什么能用渲染器的数据：它把表格的每个单元格都当元素吐出来（`table-cell`，带 `rowIndex`/`cellIndex`
 * 与已经算好的绝对 `bounds`），所以"点某一格"不用自己按 gridCol/tr 累加宽度。
 * 只把**可点选的表格**（本页 XML 里有、名字对得上的）算进来——渲染器也会画从版式继承来的东西。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EMU_PER_PX, type CanvasBox } from "./pptCanvasGeometry.js";
import type { PptxShape } from "./pptShapes.js";
import type { PptxPreviewState } from "./usePptxPreview.js";

export interface CanvasCell {
  table: string;
  row: number;
  col: number;
  box: CanvasBox;
}

export function useCanvasCells(input: {
  preview: PptxPreviewState;
  pageIndex: number;
  shapes: PptxShape[];
  layerRef: React.RefObject<HTMLDivElement | null>;
  scale: number;
  toPx: (emu: number) => number;
}) {
  const { preview, pageIndex, shapes, layerRef, scale, toPx } = input;
  const [cells, setCells] = useState<CanvasCell[]>([]);
  /**
   * 上一份**非空**的单元格索引。命中测试用它可以扛住"预览正在重算"的那一帧：
   * 那一帧 `getPageElements` 会抛、索引变空，正在进行的拖选就会突然"点不到格子"（真机实测：
   * 切页之后马上拖，只选中了第一格）。索引只在重新算出来之后才会更新，所以这一帧沿用旧的更稳。
   */
  const cellsRef = useRef<CanvasCell[]>([]);
  if (cells.length > 0) cellsRef.current = cells;

  useEffect(() => {
    let elements: readonly {
      nodeType: string;
      nodeName: string;
      rowIndex?: number;
      cellIndex?: number;
      bounds: { x: number; y: number; width: number; height: number };
    }[] = [];
    try {
      elements = preview.document?.getPageElements(pageIndex) ?? [];
    } catch {
      // 文档正在被换掉（改动后重算预览）：这一帧先不给单元格，下一帧就好
      elements = [];
    }
    setCells(
      elements
        .filter((element) => element.nodeType === "table-cell")
        .map((element) => ({
          table: element.nodeName,
          row: element.rowIndex ?? 0,
          col: element.cellIndex ?? 0,
          box: {
            x: element.bounds.x * EMU_PER_PX,
            y: element.bounds.y * EMU_PER_PX,
            width: element.bounds.width * EMU_PER_PX,
            height: element.bounds.height * EMU_PER_PX,
          },
        })),
    );
  }, [preview, pageIndex]);

  /** 命中某个单元格（只在可点选的表格里找）。 */
  const hitCell = useCallback(
    (clientX: number, clientY: number): CanvasCell | null => {
      const layer = layerRef.current;
      if (!layer || scale <= 0) return null;
      // 索引空的那一帧用上一份（见 cellsRef 的注释）
      const index = cells.length > 0 ? cells : cellsRef.current;
      const rect = layer.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const selectable = new Set(shapes.map((shape) => shape.name));
      for (const cell of [...index].reverse()) {
        if (!selectable.has(cell.table)) continue;
        const left = toPx(cell.box.x);
        const top = toPx(cell.box.y);
        const width = toPx(cell.box.width);
        const height = toPx(cell.box.height);
        if (width <= 2 || height <= 2) continue;
        if (x >= left && x <= left + width && y >= top && y <= top + height) return cell;
      }
      return null;
    },
    [cells, layerRef, scale, shapes, toPx],
  );

  /** 选中单元格的显示框（画一层细框，让用户看见点到了哪一格）。 */
  const boxOfCell = useCallback(
    (active: { table: string; row: number; col: number } | null | undefined) => {
      if (!active) return null;
      const found = cells.find(
        (cell) => cell.table === active.table && cell.row === active.row && cell.col === active.col,
      );
      return found ? { key: `${found.table}#${found.row},${found.col}`, box: found.box } : null;
    },
    [cells],
  );

  /**
   * **选中一片单元格**的显示框（含每格是不是"锚点"）。1×1 的选区就是普通的一格；
   * 拖出一片之后每格都画，看着才像 PowerPoint。
   */
  const boxesOfRange = useCallback(
    (
      active: { table: string; row0: number; col0: number; row1: number; col1: number } | null,
    ): Array<{ key: string; box: CanvasBox; anchor: boolean }> => {
      if (!active) return [];
      const rowMin = Math.min(active.row0, active.row1);
      const rowMax = Math.max(active.row0, active.row1);
      const colMin = Math.min(active.col0, active.col1);
      const colMax = Math.max(active.col0, active.col1);
      return cells
        .filter(
          (cell) =>
            cell.table === active.table &&
            cell.row >= rowMin &&
            cell.row <= rowMax &&
            cell.col >= colMin &&
            cell.col <= colMax,
        )
        .map((cell) => ({
          key: `${cell.table}#${cell.row},${cell.col}`,
          box: cell.box,
          anchor: cell.row === active.row0 && cell.col === active.col0,
        }));
    },
    [cells],
  );

  return { cells, hitCell, boxOfCell, boxesOfRange };
}
