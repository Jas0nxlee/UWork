/**
 * 画布的**视口**：量可用宽高、按"适应窗口"算缩放、处理 Ctrl/⌘ + 滚轮（以指针为中心）。
 *
 * 与形状编辑无关，所以单独成文件（画布组件要守 400 行）。
 *
 * 口径：**适应窗口**＝同时按可用宽与可用高算缩放、取小的那个（面板一开页面整体缩小、整页仍可见）；
 * `zoom` 是相对它的百分比（100 = 适应窗口）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { emuToPx, PAGE_MARGIN_PX, pxToEmu, type CanvasBox } from "./pptCanvasGeometry.js";

export interface CanvasViewport {
  width: number;
  height: number;
  scale: number;
}

export interface CanvasViewportState {
  scale: number;
  pageDisplayWidth: number;
  pageDisplayHeight: number;
  toPx: (emu: number) => number;
  toEmu: (px: number) => number;
  /** 页面级别的视口（手柄夹取、命中测试用）。 */
  viewport: CanvasViewport;
  /** 某个形状专用的视口（旋转算角度用：至少覆盖这个形状）。 */
  viewportOf: (box: CanvasBox) => CanvasViewport;
}

export function useCanvasViewport(input: {
  frameRef: React.RefObject<HTMLDivElement | null>;
  pageWidth: number;
  pageHeight: number;
  zoom: number;
  onZoomChange: (updater: (value: number) => number) => void;
}): CanvasViewportState {
  const { frameRef, pageWidth, pageHeight, zoom, onZoomChange } = input;
  const [availableWidth, setAvailableWidth] = useState(0);
  const [availableHeight, setAvailableHeight] = useState(0);

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
  }, [frameRef]);

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
  }, [frameRef, onZoomChange]);

  // 缩放后把指针底下的那个点滚回原位，否则手感是"页面乱跑"
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const pending = pendingAnchor.current;
    if (!frame || !pending) return;
    pendingAnchor.current = null;
    frame.scrollLeft = pending.fx * frame.scrollWidth - pending.px;
    frame.scrollTop = pending.fy * frame.scrollHeight - pending.py;
  }, [frameRef, zoom]);

  const fitScale = (() => {
    if (pageWidth <= 0 || pageHeight <= 0) return 0;
    const byWidth = availableWidth / pageWidth;
    const byHeight = availableHeight > 0 ? availableHeight / pageHeight : byWidth;
    return Math.min(byWidth, byHeight);
  })();
  const scale = (fitScale * zoom) / 100;
  const pageDisplayWidth = Math.round(pageWidth * scale);
  const pageDisplayHeight = Math.round(pageHeight * scale);
  const toPx = useCallback((emu: number) => emuToPx(emu, scale), [scale]);
  const toEmu = useCallback((px: number) => pxToEmu(px, scale), [scale]);
  const viewport = { width: pageDisplayWidth, height: pageDisplayHeight, scale };
  const viewportOf = (box: CanvasBox) => ({
    width: Math.max(pageDisplayWidth, Math.ceil(toPx(box.width)) + 2),
    height: Math.max(pageDisplayHeight, Math.ceil(toPx(box.height)) + 2),
    scale,
  });

  return {
    scale,
    pageDisplayWidth,
    pageDisplayHeight,
    toPx,
    toEmu,
    viewport,
    viewportOf,
  };
}
