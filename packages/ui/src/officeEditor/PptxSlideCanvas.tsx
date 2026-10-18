/**
 * PPT 编辑位的**幻灯片画布**：把当前页渲染出来，并在上面叠一层"可点选、可拖动、可拉角缩放"的形状框。
 *
 * **两套坐标，别混**：
 *   - XML 里（`a:off` / `a:ext`）是 **EMU**（1 厘米 = 360000 EMU，16:9 一页 9144000×6858000）；
 *   - 渲染器（产品在用的那个，也用在预览视图里）给的是 **96 dpi 的像素**（`pageSize` 就是 960×720，
 *     因为 9144000 EMU = 10 英寸 = 960 px），它的节点几何也是这个像素。
 * 换算是固定的 `1 px = 9525 EMU`（914400 / 96）。本组件内部**一律用 EMU 记账**
 * （从渲染器读出来的量立刻乘 9525），只在画到屏幕上时才 `emu → px`：`px = emu / 9525 × scale`，
 * 其中 `scale = 图层宽 / pageSize.width`。写回 XML 时用 `emu = px / scale × 9525`。
 *
 * **几何相关的 CSS 一律写成 inline style**：检查脚手架页面里没有 Tailwind，
 * 用 class 写 `relative` / `overflow-hidden` / `origin-top-left` 会在那儿全部失效
 * （实测：缩放层绕中心放大、盖住整个编辑位，左侧列表点不动）。样式（颜色/边框）照旧用 class。
 *
 * **只有"能写回去"的形状才可点选**：点选名单以幻灯片 XML 里的形状为准（`p:sp` / `p:pic` /
 * `p:graphicFrame`，身份是 `p:cNvPr@name`）；渲染器还会画出**从版式/母版继承来的**那些形状，
 * 它们不在本页 XML 里、改了也写不回去，所以不进点选名单——宁可点不到，不能"拖了半天没反应"。
 * 几何优先用 XML 里的显式 `a:xfrm`，没有（继承版式）就用渲染器量到的框；两个都没有就不给拖，
 * 提示去检查器里填——检查器一提交就会落下显式几何，之后画布上就能拖了。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { pptxRendererPreviewEngine } from "@/presentation/pptxRendererPreviewEngine.js";
import type { PptxShape } from "./pptShapes.js";

interface CanvasBox {
  /** EMU（与 XML 的 a:off/a:ext 同一口径）。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PptxSlideCanvasProps {
  /** 当前文件字节（含未保存改动；编辑位每次改动后重算）。 */
  bytes: ArrayBuffer | null;
  /** 显示哪一页：按部件名找（渲染器页序是它自己的解析序，未必等于放映序）。 */
  partName: string;
  /** 页序兜底（渲染器对"一个元素都没有的页"给不出部件名）。 */
  slideIndex: number;
  /** 从 XML 读出的形状：**点选名单**以它为准。 */
  shapes: PptxShape[];
  activeShape: string | null;
  onSelect: (name: string | null) => void;
  onCommitBounds: (
    name: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) => void;
  /** 双击：希望就地改这个形状的文字（编辑位负责把焦点移到对应文本框）。 */
  onRequestText?: (name: string) => void;
}

type DragState = {
  mode: "move" | "resize";
  corner: "nw" | "ne" | "sw" | "se";
  name: string;
  startX: number;
  startY: number;
  start: CanvasBox;
};

/** 最小尺寸约 0.5 厘米：别让人把形状拖成 0（那样它就再也点不到了）。 */
const MIN_EMU = 180000;
const PAGE_MARGIN_PX = 8;
/** 96 dpi 像素 → EMU（914400 EMU/英寸 ÷ 96 px/英寸）。渲染器的 pageSize 与节点几何都是前者。 */
const EMU_PER_PX = 9525;

export function PptxSlideCanvas({
  bytes,
  partName,
  slideIndex,
  shapes,
  activeShape,
  onSelect,
  onCommitBounds,
  onRequestText,
}: PptxSlideCanvasProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [measured, setMeasured] = useState<Record<string, CanvasBox>>({});
  const [renderError, setRenderError] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  /** 拖动中的实时几何（EMU）：只在拖的时候覆盖显示，松手才写回 XML。 */
  const [draft, setDraft] = useState<{ name: string; box: CanvasBox } | null>(null);

  // 可用宽度（面板变窄 / 窗口缩放都要跟着重算，否则框会错位）
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => setAvailableWidth(Math.max(0, frame.clientWidth - PAGE_MARGIN_PX * 2));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // 渲染当前页；bytes 或页码变了就重画
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !bytes) return;
    let disposed = false;
    let handle: { dispose: () => void; ready: Promise<void> } | null = null;
    let preview: { dispose: () => void } | null = null;
    const run = async () => {
      try {
        const document = await pptxRendererPreviewEngine.open(bytes.slice(0));
        if (disposed) {
          document.dispose();
          return;
        }
        preview = document;
        const tail = partName.split("/").pop() ?? partName;
        let pageIndex = -1;
        for (let index = 0; index < document.pageCount; index += 1) {
          const elements = document.getPageElements(index);
          if (
            elements.some(
              (element) => element.slidePart === partName || element.slidePart.endsWith(tail),
            )
          ) {
            pageIndex = index;
            break;
          }
        }
        if (pageIndex < 0) pageIndex = Math.min(slideIndex, Math.max(0, document.pageCount - 1));
        const elements = document.getPageElements(pageIndex);
        const boxes: Record<string, CanvasBox> = {};
        for (const element of elements) {
          // 渲染器的几何是像素：换成 EMU 再记账，后面只跟 EMU 打交道
          boxes[element.nodeName] = {
            x: element.bounds.x * EMU_PER_PX,
            y: element.bounds.y * EMU_PER_PX,
            width: element.bounds.width * EMU_PER_PX,
            height: element.bounds.height * EMU_PER_PX,
          };
        }
        host.replaceChildren();
        const rendered = document.renderPage(pageIndex, host);
        handle = rendered;
        await rendered.ready;
        if (disposed) return;
        setRenderError(null);
        setPageSize({ width: document.pageSize.width, height: document.pageSize.height });
        setMeasured(boxes);
      } catch (error) {
        if (!disposed) setRenderError(error instanceof Error ? error.message : String(error));
      }
    };
    void run();
    return () => {
      disposed = true;
      handle?.dispose();
      preview?.dispose();
      host.replaceChildren();
    };
  }, [bytes, partName, slideIndex]);

  const scale = pageSize && availableWidth > 0 ? availableWidth / pageSize.width : 0;
  const displayHeight = pageSize ? Math.round(pageSize.height * scale) : 0;
  /** 屏幕像素 → EMU（把指针位移换成 XML 单位）。 */
  const toEmu = useCallback((px: number) => (scale > 0 ? (px / scale) * EMU_PER_PX : 0), [scale]);
  /** EMU → 屏幕像素（把 XML 几何画到图层上）。 */
  const toPx = useCallback((emu: number) => (scale > 0 ? (emu / EMU_PER_PX) * scale : 0), [scale]);

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

  /** 命中测试：从上层往下找（渲染器给的顺序就是 z 序）。 */
  const hitTest = useCallback(
    (clientX: number, clientY: number): string | null => {
      const frame = frameRef.current;
      if (!frame || scale <= 0) return null;
      const rect = frame.getBoundingClientRect();
      const x = clientX - rect.left - PAGE_MARGIN_PX;
      const y = clientY - rect.top - PAGE_MARGIN_PX;
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

  /** 拖动中的几何（EMU）：往里/往北拉时左上角跟着走，但右下角不动。 */
  const geometryFor = useCallback((state: DragState, dx: number, dy: number): CanvasBox => {
    const base = state.start;
    if (state.mode === "move") {
      return {
        x: Math.round(base.x + dx),
        y: Math.round(base.y + dy),
        width: base.width,
        height: base.height,
      };
    }
    const west = state.corner === "nw" || state.corner === "sw";
    const north = state.corner === "nw" || state.corner === "ne";
    const width = Math.max(MIN_EMU, west ? base.width - dx : base.width + dx);
    const height = Math.max(MIN_EMU, north ? base.height - dy : base.height + dy);
    return {
      x: Math.round(west ? base.x + (base.width - width) : base.x),
      y: Math.round(north ? base.y + (base.height - height) : base.y),
      width: Math.round(width),
      height: Math.round(height),
    };
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
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

  const startResize = (event: React.PointerEvent<HTMLSpanElement>, corner: DragState["corner"]) => {
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
      box: geometryFor(
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
    onCommitBounds(state.name, geometryFor(state, dx, dy));
  };

  const activeBox = activeShape ? boxOf(activeShape) : null;
  const activeShapeKnown = activeShape ? shapes.some((item) => item.name === activeShape) : false;
  const hint =
    activeShapeKnown && activeBox
      ? `（当前「${activeShape}」${Math.round(activeBox.width / 3600) / 100} × ${Math.round(activeBox.height / 3600) / 100} 厘米）`
      : activeShapeKnown
        ? `（「${activeShape}」的位置大小继承自版式，先在检查器里填一次，之后就能在画布上拖）`
        : "";

  return (
    <div className="pb-2">
      <div
        ref={frameRef}
        className="relative w-full overflow-hidden rounded border border-border bg-background"
        style={{
          position: "relative",
          overflow: "hidden",
          height: displayHeight > 0 ? displayHeight + PAGE_MARGIN_PX * 2 : 140,
        }}
        data-pptx-canvas-frame
        // 检查脚手架按这两个数算点击点：emu = (显示 px ÷ scale) × 9525
        data-pptx-canvas-ready={scale > 0 ? "true" : "false"}
        data-pptx-canvas-scale={scale}
        // 页宽用 EMU 报（渲染器给的是 96dpi 像素，×9525 才是 XML 口径）
        data-pptx-canvas-page-width={Math.round((pageSize?.width ?? 0) * EMU_PER_PX)}
        data-pptx-canvas-page-height={Math.round((pageSize?.height ?? 0) * EMU_PER_PX)}
      >
        {/* 渲染层：与预览视图同款——渲染器的像素当像素，再整体缩放到可用宽 */}
        <div
          className="absolute origin-top-left"
          style={{
            position: "absolute",
            left: PAGE_MARGIN_PX,
            top: PAGE_MARGIN_PX,
            width: pageSize?.width ?? 0,
            height: pageSize?.height ?? 0,
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
        {/* 交互层：全在"显示像素"这一层，EMU↔px 的换算只发生在 toEmu/toPx 里 */}
        {scale > 0 ? (
          <div
            className="cursor-default"
            style={{
              position: "absolute",
              left: PAGE_MARGIN_PX,
              top: PAGE_MARGIN_PX,
              width: availableWidth,
              height: displayHeight,
            }}
            data-pptx-canvas-layer
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(event) => {
              const name = hitTest(event.clientX, event.clientY);
              if (name && onRequestText) onRequestText(name);
            }}
          >
            {activeBox ? (
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
              >
                {(
                  [
                    ["nw", { left: 0, top: 0 }, "nwse-resize"],
                    ["ne", { right: 0, top: 0 }, "nesw-resize"],
                    ["sw", { left: 0, bottom: 0 }, "nesw-resize"],
                    ["se", { right: 0, bottom: 0 }, "nwse-resize"],
                  ] as const
                ).map(([corner, anchor, cursor]) => (
                  <span
                    key={corner}
                    data-pptx-canvas-handle={corner}
                    className="rounded-full border border-sky-500 bg-white"
                    style={{
                      position: "absolute",
                      width: 12,
                      height: 12,
                      cursor,
                      // 手柄骑在角上：往外挪半个身位
                      ...("left" in anchor ? { left: -6 } : { right: -6 }),
                      ...("top" in anchor ? { top: -6 } : { bottom: -6 }),
                    }}
                    onPointerDown={(event) => startResize(event, corner)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {renderError ? (
          <div
            className="flex items-center justify-center px-4 text-center text-[11px] text-foreground-subtle"
            style={{ position: "absolute", inset: 0 }}
          >
            这一页渲染不出来（{renderError.slice(0, 60)}）——仍可以用下面的形状列表与检查器改。
          </div>
        ) : null}
      </div>
      <div className="pt-1 text-[10px] text-foreground-subtlest">
        画布：点形状选中 · 拖动移动 · 拉四角缩放{hint}
      </div>
    </div>
  );
}
