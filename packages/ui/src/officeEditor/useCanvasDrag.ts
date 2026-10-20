/**
 * 画布上的**拖动状态机**：移动 / 拉角缩放 / 旋转 / 表格选一片（+ 小表格的"抓着走"）。
 *
 * 单独成文件的原因：画布那个组件要守 400 行；这块也确实自成一摊（按下→移动→松手，三件事共用一份状态）。
 *
 * 几条口径（都是真机踩出来的）：
 *   - **表格**：格子内拖＝选一片单元格；**靠边框几像素拖＝移动整张表**；表格小到没有"边框"可抓时，
 *     按下直接按"抓表"走（否则小表根本拖不动）。点一下（没有位移）仍然是选那一格。
 *   - **拖动中不写 XML**：`draft` 只是显示，松手（位移 > 1000 EMU）才 `onCommitBounds`。
 *   - 单元格拖选用**同步 ref**：按下之后紧跟着的 pointermove 可能早于 React 提交 state。
 */
import { useRef, useState } from "react";
import {
  angleFromCenter,
  dragGeometry,
  type CanvasBox,
  type CanvasCorner,
  type CanvasDragState,
  type CanvasViewport,
} from "./pptCanvasGeometry.js";

export function useCanvasDrag(input: {
  layerRef: React.RefObject<HTMLDivElement | null>;
  scale: number;
  viewport: CanvasViewport;
  toPx: (emu: number) => number;
  toEmu: (px: number) => number;
  activeShape: string | null;
  editing: boolean;
  boxOf: (name: string) => CanvasBox | null;
  hitTest: (clientX: number, clientY: number) => string | null;
  hitCell: (
    clientX: number,
    clientY: number,
  ) => { table: string; row: number; col: number; box: CanvasBox } | null;
  onTableEdge: (
    clientX: number,
    clientY: number,
    tableName: string,
    cell: { box: CanvasBox },
  ) => boolean;
  onSelect: (name: string | null) => void;
  onSelectCell?: ((table: string, row: number, col: number) => void) | undefined;
  onExtendCell?: ((table: string, row: number, col: number) => void) | undefined;
  onCommitBounds: (
    name: string,
    bounds: { x?: number; y?: number; width?: number; height?: number; rotation?: number },
  ) => void;
  /**
   * 拖动中的实时几何（同一个对象**同时**放 state 和 ref）：
   * `boxOf` 要能在渲染前读到它（用 state 会"用之前未声明"——boxOf 在 hook 之前定义）。
   */
  draftRef: React.RefObject<{ name: string; box: CanvasBox } | null>;
}) {
  const [drag, setDrag] = useState<CanvasDragState | null>(null);
  /** 拖动中的实时几何（EMU）：只在拖动时覆盖显示，松手才写回。 */
  const [draft, setDraft] = useState<{ name: string; box: CanvasBox } | null>(null);
  const writeDraft = (value: { name: string; box: CanvasBox } | null) => {
    input.draftRef.current = value;
    setDraft(value);
  };
  /** 旋转中的实时角度（度）：松手才写回 a:xfrm@rot。 */
  const [rotateDraft, setRotateDraft] = useState<number | null>(null);
  const cellDragRef = useRef<string | null>(null);

  const startMove = (event: React.PointerEvent<HTMLDivElement>, name: string, box: CanvasBox) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({
      mode: "move",
      corner: "se",
      name,
      startX: event.clientX,
      startY: event.clientY,
      start: box,
    });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // 正在就地改字：点画布＝先提交（编辑层的 blur 会接管），不要顺手拖动
    if (input.editing) return;
    const { hitCell, onSelect, onSelectCell, onTableEdge, boxOf } = input;
    const cell = hitCell(event.clientX, event.clientY);
    if (cell) {
      // 表格里点到单元格：格内＝选这一格（拖到别的格扩成一片）；**靠边框那一圈＝拖整张表**
      // （PowerPoint 同款；早先"边框"是 0 像素宽，整张表拖不动——真机反馈）。
      if (onTableEdge(event.clientX, event.clientY, cell.table, cell)) {
        const frame = boxOf(cell.table);
        if (!frame) return;
        onSelect(cell.table);
        onSelectCell?.(cell.table, cell.row, cell.col);
        startMove(event, cell.table, frame);
        return;
      }
      onSelect(cell.table);
      onSelectCell?.(cell.table, cell.row, cell.col);
      cellDragRef.current = cell.table;
      event.stopPropagation();
      return;
    }
    const name = input.hitTest(event.clientX, event.clientY);
    onSelect(name);
    if (!name) return;
    const box = boxOf(name);
    if (!box) return;
    event.preventDefault();
    startMove(event, name, box);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    // 表格里拖选：先看 ref（第一下就接得住），与形状拖动互不影响
    if (cellDragRef.current) {
      const cell = input.hitCell(event.clientX, event.clientY);
      if (cell && cell.table === cellDragRef.current) {
        input.onExtendCell?.(cell.table, cell.row, cell.col);
      }
      return;
    }
    if (!drag) return;
    if (drag.mode === "rotate") {
      const layer = input.layerRef.current;
      if (!layer) return;
      const rect = layer.getBoundingClientRect();
      setRotateDraft(
        angleFromCenter(
          drag.start,
          input.viewport,
          event.clientX - rect.left,
          event.clientY - rect.top,
        ),
      );
      return;
    }
    writeDraft({
      name: drag.name,
      box: dragGeometry(
        drag,
        input.toEmu(event.clientX - drag.startX),
        input.toEmu(event.clientY - drag.startY),
      ),
    });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    cellDragRef.current = null;
    if (!drag) return;
    const state = drag;
    setDrag(null);
    writeDraft(null);
    if (state.mode === "rotate") {
      const rotation = rotateDraft ?? state.start.rotation ?? 0;
      setRotateDraft(null);
      // 没转过 1° 就别写（免得点一下也产生"改动"）
      if (Math.abs(rotation - (state.start.rotation ?? 0)) < 1) return;
      input.onCommitBounds(state.name, { rotation });
      return;
    }
    const dx = input.toEmu(event.clientX - state.startX);
    const dy = input.toEmu(event.clientY - state.startY);
    // 只是点了一下（没真的拖动）：不写回，也不制造一条"改动"
    if (Math.abs(dx) < 1000 && Math.abs(dy) < 1000) return;
    input.onCommitBounds(state.name, dragGeometry(state, dx, dy));
  };

  /** 拉旋转手柄：以形状中心为轴（与拖动/缩放共用同一套 drag 状态与指针事件）。 */
  const startRotate = (event: React.PointerEvent<HTMLSpanElement>) => {
    const name = input.activeShape;
    if (!name) return;
    const box = input.boxOf(name);
    if (!box) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({
      mode: "rotate",
      corner: "se",
      name,
      startX: event.clientX,
      startY: event.clientY,
      start: box,
    });
    setRotateDraft(box.rotation ?? 0);
  };

  const startResize = (event: React.PointerEvent<HTMLSpanElement>, corner: CanvasCorner) => {
    const name = input.activeShape;
    if (!name) return;
    const box = input.boxOf(name);
    if (!box) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({
      mode: "resize",
      corner,
      name,
      startX: event.clientX,
      startY: event.clientY,
      start: box,
    });
  };

  return {
    drag,
    draft,
    rotateDraft,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    startRotate,
    startResize,
  };
}
