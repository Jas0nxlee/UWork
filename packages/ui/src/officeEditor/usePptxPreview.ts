/**
 * PPT 编辑位的**共享预览文档**：一整份文件只解析一次，画布与左侧缩略图共用。
 *
 * 之前画布是"每次改动都 `pptxRendererPreviewEngine.open(bytes)` 重开一份"，缩略图再来一遍就是 N+1 次
 * 解压解析。这里开一次、按页渲染多个容器（渲染器支持一份文档多个 handle），改动时只换 bytes。
 *
 * 页序：渲染器的页序是它自己的解析序，**未必等于放映序**，所以给部件名做了反查（`pageIndexOf`）；
 * 查不到（例如这一页一个元素都没有）再退回调用方给的序号。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pptxRendererPreviewEngine } from "@/presentation/pptxRendererPreviewEngine.js";
import type {
  PresentationPreviewDocument,
  PresentationRenderHandle,
} from "@/presentation/types.js";

export interface PptxPreviewState {
  document: PresentationPreviewDocument | null;
  pageCount: number;
  pageWidth: number;
  pageHeight: number;
  error: string | null;
  /** 幻灯片部件名 → 渲染器页序号。 */
  pageIndexOf: (partName: string, fallback: number) => number;
  /** 往容器里画一页（调用方负责 handle.dispose()；文档被换掉时 handle 会自动失效）。 */
  renderPage: (index: number, container: HTMLElement) => PresentationRenderHandle | null;
}

export function usePptxPreview(bytes: ArrayBuffer | null): PptxPreviewState {
  const [document, setDocument] = useState<PresentationPreviewDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 部件名 → 页序（每次解析后算一遍，避免每页都去遍历元素）。 */
  const indexRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    indexRef.current = new Map();
    if (!bytes) {
      setDocument(null);
      setError(null);
      return;
    }
    let disposed = false;
    let opened: PresentationPreviewDocument | null = null;
    setError(null);
    pptxRendererPreviewEngine
      .open(bytes.slice(0))
      .then((next) => {
        if (disposed) {
          next.dispose();
          return;
        }
        opened = next;
        const index = new Map<string, number>();
        for (let page = 0; page < next.pageCount; page += 1) {
          for (const element of next.getPageElements(page)) {
            if (!index.has(element.slidePart)) index.set(element.slidePart, page);
          }
        }
        indexRef.current = index;
        setDocument(next);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
      // **推迟一轮再销毁**：改动（bytes 变化）时，画布/缩略图可能还有一次读或渲染在飞，
      // 同步 dispose 会让它们撞上 "Presentation preview document has been disposed"
      // （真机实测：编辑一次就把整个编辑位打成错误页）。与 Excel 引擎宿主的卸载同一个坑。
      const stale = opened;
      window.setTimeout(() => {
        try {
          stale?.dispose();
        } catch {
          // 已经销毁过就算了
        }
      }, 0);
      setDocument((current) => (current === stale ? null : current));
    };
  }, [bytes]);

  const pageIndexOf = useCallback((partName: string, fallback: number) => {
    const tail = partName.split("/").pop() ?? partName;
    const direct = indexRef.current.get(partName);
    if (direct !== undefined) return direct;
    for (const [part, page] of indexRef.current) {
      if (part.endsWith(tail)) return page;
    }
    return fallback;
  }, []);

  const renderPage = useCallback(
    (index: number, container: HTMLElement) => {
      if (!document || index < 0 || index >= document.pageCount) return null;
      try {
        return document.renderPage(index, container);
      } catch {
        return null;
      }
    },
    [document],
  );

  return useMemo(
    () => ({
      document,
      pageCount: document?.pageCount ?? 0,
      pageWidth: document?.pageSize.width ?? 0,
      pageHeight: document?.pageSize.height ?? 0,
      error,
      pageIndexOf,
      renderPage,
    }),
    [document, error, pageIndexOf, renderPage],
  );
}
