/**
 * 左栏的一枚**幻灯片缩略图**（PowerPoint 那种：真缩略图 + 页码 + 当前页高亮）。
 *
 * 画法与主画布同一套：渲染器按"整页尺寸"画，外面用 `transform: scale()` 缩到缩略图宽度。
 * 缩到视口里才画（大文稿不必一次画几十页）——用 IntersectionObserver 判断。
 */
import { useEffect, useRef, useState } from "react";
import type { PptxPreviewState } from "./usePptxPreview.js";

export interface PptxSlideThumbProps {
  preview: PptxPreviewState;
  pageIndex: number;
  width: number;
  active: boolean;
  onSelect: () => void;
}

export function PptxSlideThumb({
  preview,
  pageIndex,
  width,
  active,
  onSelect,
}: PptxSlideThumbProps) {
  const boxRef = useRef<HTMLButtonElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const scale = preview.pageWidth > 0 ? width / preview.pageWidth : 0;

  useEffect(() => {
    const node = boxRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: "120px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !visible || scale <= 0) return;
    host.replaceChildren();
    const handle = preview.renderPage(pageIndex, host);
    if (!handle) {
      setFailed(true);
      return () => host.replaceChildren();
    }
    setFailed(false);
    void handle.ready.catch(() => setFailed(true));
    return () => {
      try {
        handle.dispose();
      } catch {
        // 文档已经被换掉了：handle 失效是正常的
      }
      host.replaceChildren();
    };
  }, [preview, pageIndex, scale, visible]);

  const height = Math.round(preview.pageHeight * scale);

  return (
    <button
      type="button"
      ref={boxRef}
      data-pptx-slide={pageIndex + 1}
      data-pptx-slide-active={active ? "true" : "false"}
      onClick={onSelect}
      className="flex w-full items-start gap-1 rounded px-1 py-1 text-left"
      style={{ background: active ? "rgba(56,189,248,0.16)" : "transparent" }}
    >
      <span className="w-4 shrink-0 pt-1 text-right text-[10px] text-foreground-subtle">
        {pageIndex + 1}
      </span>
      <span
        className="relative block shrink-0 overflow-hidden rounded-sm bg-white"
        style={{
          width,
          height,
          border: active ? "2px solid rgb(14,165,233)" : "1px solid var(--color-border)",
        }}
      >
        <span
          className="block origin-top-left"
          style={{
            width: preview.pageWidth || 1,
            height: preview.pageHeight || 1,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          <span
            ref={hostRef}
            className="pointer-events-none block"
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            data-pptx-thumb-host={pageIndex}
          />
        </span>
        {failed || (visible && preview.error) ? (
          <span className="absolute inset-0 flex items-center justify-center text-[10px] text-foreground-subtlest">
            第 {pageIndex + 1} 页
          </span>
        ) : null}
      </span>
    </button>
  );
}
