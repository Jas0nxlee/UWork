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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  dragGeometry,
  emuToPx,
  measuredBoxesOf,
  EMU_PER_PX,
  handleSpots,
  isOffPage,
  PAGE_MARGIN_PX,
  pxToEmu,
  type CanvasBox,
  type CanvasCorner,
  type CanvasDragState,
} from "./pptCanvasGeometry.js";
import { PptxCanvasZoomBar } from "./PptxCanvasZoomBar.js";
import { PptxTextEditor } from "./PptxTextEditor.js";
import type { PresentationPageElement } from "@/presentation/types.js";
import type { PptxShape } from "./pptShapes.js";
import type { PptxPreviewState } from "./usePptxPreview.js";

export interface PptxSlideCanvasProps {
  /** 共享的预览文档（一份文件只解析一次）。 */
  preview: PptxPreviewState;
  /** 渲染器页序号（编辑位用 `preview.pageIndexOf` 从部件名换出来）。 */
  pageIndex: number;
  /** 这一页的部件名（换页时用来重挂渲染面）。 */
  partName: string;
  /** 从 XML 读出的形状：**点选名单**以它为准。 */
  shapes: PptxShape[];
  activeShape: string | null;
  onSelect: (name: string | null) => void;
  onCommitBounds: (
    name: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) => void;
  /** 双击：希望就地改这个形状的文字（编辑位负责把焦点移到编辑层）。 */
  onRequestText?: (name: string) => void;
  /** 缩放百分比（100 = 适应宽度）：由编辑位持有，功能区「视图」也要改它。 */
  zoom: number;
  onZoomChange: (updater: (value: number) => number) => void;
  /** 打开右侧「设置形状格式」窗格（窗格默认收起，免得把画布挤窄）。 */
  onOpenFormatPane: () => void;
  /** 就地改字（双击形状进入）：null 表示不在编辑。 */
  editing: { shape: string; text: string } | null;
  onEditingText: (text: string) => void;
  onEditingCommit: () => void;
  onEditingCancel: () => void;
}

export function PptxSlideCanvas({
  preview,
  pageIndex,
  partName,
  shapes,
  activeShape,
  onSelect,
  onCommitBounds,
  onRequestText,
  zoom,
  onZoomChange,
  onOpenFormatPane,
  editing,
  onEditingText,
  onEditingCommit,
  onEditingCancel,
}: PptxSlideCanvasProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [availableHeight, setAvailableHeight] = useState(0);
  const [measured, setMeasured] = useState<Record<string, CanvasBox>>({});
  const [drag, setDrag] = useState<CanvasDragState | null>(null);
  /** 拖动中的实时几何（EMU）：只在拖的时候覆盖显示，松手才写回 XML。 */
  const [draft, setDraft] = useState<{ name: string; box: CanvasBox } | null>(null);

  // 可用宽度（面板变窄 / 窗口缩放都要跟着重算，否则框会错位）
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => {
      setAvailableWidth(Math.max(0, frame.clientWidth - PAGE_MARGIN_PX * 2));
      setAvailableHeight(Math.max(0, frame.clientHeight - PAGE_MARGIN_PX * 2));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // 画当前页（文档换了或换页就重画）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    const handle = preview.renderPage(pageIndex, host);
    if (!handle) return;
    return () => {
      try {
        handle.dispose();
      } catch {
        // 文档已换掉：handle 失效属正常
      }
      host.replaceChildren();
    };
  }, [preview, pageIndex, partName]);

  // 渲染器实测的每个形状框（XML 里没有显式几何的用它兜底）
  useEffect(() => {
    let page: readonly PresentationPageElement[] = [];
    try {
      page = preview.document?.getPageElements(pageIndex) ?? [];
    } catch {
      // 文档正在被换掉（改动后重算预览）：这一帧先不给兜底几何，下一帧就好了
      page = [];
    }
    setMeasured(measuredBoxesOf(page));
  }, [preview, pageIndex]);

  /** Ctrl/⌘ + 滚轮（触控板捏合）＝ 缩放，且**以指针为中心**（PowerPoint 的手感）。 */
  const pendingAnchor = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      // 要拦掉"浏览器缩放"，监听必须是非 passive 的，所以用原生监听而不是 React 的 onWheel
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      pendingAnchor.current = {
        px,
        py,
        fx: (frame.scrollLeft + px) / Math.max(1, frame.scrollWidth),
        fy: (frame.scrollTop + py) / Math.max(1, frame.scrollHeight),
      };
      onZoomChange((value) => Math.max(25, Math.min(400, value + (event.deltaY < 0 ? 10 : -10))));
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [onZoomChange]);

  // 缩放后把指针底下的那个点滚回原位，否则手感是"页面乱跑"
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const pending = pendingAnchor.current;
    if (!frame || !pending) return;
    pendingAnchor.current = null;
    frame.scrollLeft = pending.fx * frame.scrollWidth - pending.px;
    frame.scrollTop = pending.fy * frame.scrollHeight - pending.py;
  }, [zoom]);

  /**
   * **适应窗口**：同时按可用宽与可用高算缩放，取小的那个。
   * PowerPoint 就是这样——旁边面板一开，页面整体缩小、**整页仍然看得见**，
   * 而不是"按宽度铺满、底下被切掉"或者被面板盖住。
   */
  const fitScale = (() => {
    if (preview.pageWidth <= 0 || preview.pageHeight <= 0) return 0;
    const byWidth = availableWidth / preview.pageWidth;
    const byHeight = availableHeight > 0 ? availableHeight / preview.pageHeight : byWidth;
    return Math.min(byWidth, byHeight);
  })();
  const scale = (fitScale * zoom) / 100;
  const pageDisplayWidth = Math.round((preview.pageWidth || 0) * scale);
  const pageDisplayHeight = Math.round((preview.pageHeight || 0) * scale);
  const toEmu = useCallback((px: number) => pxToEmu(px, scale), [scale]);
  const toPx = useCallback((emu: number) => emuToPx(emu, scale), [scale]);

  /** 形状的显示几何：XML 显式几何优先，否则用渲染器量到的；都没有 = 不可拖。 */
  const boxOf = useCallback(
    (name: string): CanvasBox | null => {
      if (draft?.name === name) return draft.box;
      const shape = shapes.find((item) => item.name === name);
      if (!shape) return null;
      if (shape.bounds.explicit) {
        return {
          x: shape.bounds.x,
          y: shape.bounds.y,
          width: shape.bounds.width,
          height: shape.bounds.height,
        };
      }
      return measured[name] ?? null;
    },
    [draft, measured, shapes],
  );

  /** 命中测试：从上层往下找（渲染器给的顺序就是 z 序）。坐标用**交互层**算，容器滚动也不跑偏。 */
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
    [boxOf, scale, shapes, toPx],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // 正在就地改字：点画布＝先提交（编辑层的 blur 会接管），不要顺手拖动
    if (editing) return;
    const name = hitTest(event.clientX, event.clientY);
    onSelect(name);
    if (!name) return;
    const box = boxOf(name);
    if (!box) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    setDrag({
      mode: "move",
      corner: "se",
      name,
      startX: event.clientX,
      startY: event.clientY,
      start: box,
    });
  };

  const startResize = (event: React.PointerEvent<HTMLSpanElement>, corner: CanvasCorner) => {
    if (!activeShape) return;
    const box = boxOf(activeShape);
    if (!box) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({
      mode: "resize",
      corner,
      name: activeShape,
      startX: event.clientX,
      startY: event.clientY,
      start: box,
    });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDraft({
      name: drag.name,
      box: dragGeometry(
        drag,
        toEmu(event.clientX - drag.startX),
        toEmu(event.clientY - drag.startY),
      ),
    });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const state = drag;
    setDrag(null);
    setDraft(null);
    const dx = toEmu(event.clientX - state.startX);
    const dy = toEmu(event.clientY - state.startY);
    // 只是点了一下（没真的拖动）：不写回，也不制造一条"改动"
    if (Math.abs(dx) < 1000 && Math.abs(dy) < 1000) return;
    onCommitBounds(state.name, dragGeometry(state, dx, dy));
  };

  const activeBox = activeShape ? boxOf(activeShape) : null;
  /** 正在编辑的形状（拿它的格式去渲染编辑层）。 */
  const shapeOfEditing = editing
    ? (shapes.find((item) => item.name === editing.shape) ?? null)
    : null;
  const activeShapeKnown = activeShape ? shapes.some((item) => item.name === activeShape) : false;
  const viewport = { width: pageDisplayWidth, height: pageDisplayHeight, scale };
  const handleSpotList = activeBox ? handleSpots(activeBox, viewport) : [];
  const offPage = activeBox ? isOffPage(activeBox, viewport) : false;
  const hint = activeShapeKnown
    ? activeBox
      ? offPage
        ? `「${activeShape}」整块在页面外：拉页边的手柄拖回来，或在右侧窗格里改 X/Y`
        : `已选中「${activeShape}」 · ${Math.round(activeBox.width / 3600) / 100} × ${Math.round(activeBox.height / 3600) / 100} 厘米`
      : `「${activeShape}」的位置大小继承自版式，先在右侧窗格里填一次，之后就能在画布上拖`
    : "点形状选中，拖动移动，拉四角缩放";

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
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onDoubleClick={(event) => {
                if (editing) return;
                const name = hitTest(event.clientX, event.clientY);
                if (name && onRequestText) onRequestText(name);
              }}
            >
              {/* 就地改字：编辑层盖在形状位置上，字号/对齐/颜色按这个形状现有的格式算 */}
              {editing && activeBox ? (
                <PptxTextEditor
                  box={activeBox}
                  scale={scale}
                  format={shapeOfEditing?.runFormat ?? {}}
                  align={shapeOfEditing?.textBodies[0]?.[0]?.align}
                  value={editing.text}
                  onChange={onEditingText}
                  onCommit={onEditingCommit}
                  onCancel={onEditingCancel}
                />
              ) : null}
              {activeBox && !editing ? (
                <div
                  data-pptx-canvas-selection={activeShape ?? ""}
                  className="border-2 border-sky-400"
                  style={{
                    position: "absolute",
                    left: toPx(activeBox.x),
                    top: toPx(activeBox.y),
                    width: toPx(activeBox.width),
                    height: toPx(activeBox.height),
                    cursor: drag?.mode === "move" ? "grabbing" : "grab",
                  }}
                />
              ) : null}
              {/* 手柄与选框**同级**、都用页面坐标（挂在选框里的话，位置会被选框自身的 left/top 再加一遍） */}
              {activeBox && !editing
                ? handleSpotList.map(({ corner, left, top, cursor }) => (
                    <span
                      key={corner}
                      data-pptx-canvas-handle={corner}
                      className="rounded-full border border-sky-500 bg-white"
                      style={{
                        position: "absolute",
                        width: 12,
                        height: 12,
                        cursor,
                        left,
                        top,
                      }}
                      onPointerDown={(event) => startResize(event, corner)}
                    />
                  ))
                : null}
            </div>
          ) : null}
          {preview.error ? (
            <div
              className="flex items-center justify-center px-4 text-center text-[11px] text-foreground-subtle"
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
