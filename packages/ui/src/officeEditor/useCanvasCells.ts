/**
 * 画布上的**表格单元格索引**：从渲染器的元素里取"表名 + 行列号 + 绝对框"，做命中测试与选中框。
 *
 * 为什么能用渲染器的数据：它把表格的每个单元格都当元素吐出来（`table-cell`，带 `rowIndex`/`cellIndex`
 * 与已经算好的绝对 `bounds`），所以"点某一格"不用自己按 gridCol/tr 累加宽度。
 * 只把**可点选的表格**（本页 XML 里有、名字对得上的）算进来——渲染器也会画从版式继承来的东西。
 */
import { useCallback, useEffect, useState } from "react";
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
      const rect = layer.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const selectable = new Set(shapes.map((shape) => shape.name));
      for (const cell of [...cells].reverse()) {
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

  return { cells, hitCell, boxOfCell };
}
