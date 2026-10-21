/**
 * 画布的**渲染两件事**：把当前页画进宿主节点，以及量出渲染器实测的每个形状框。
 *
 * 单独成文件的理由：画布那个组件要守 400 行（抽出来之前它在 428 行）。
 *
 * 两个细节都是踩出来的：
 *   - **必须给 handle.dispose()**：文档被换掉时旧页的 DOM/监听不清会越积越多；
 *   - `renderKey`（编辑位每次改 XML +1）**必须进依赖**：只靠"字节变了"触发的重画不够——
 *     真机实测删掉图片后形状列表已经没了、画布上那张图还在（等几秒也不消失）。
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { measuredBoxesOf, type CanvasBox } from "./pptCanvasGeometry.js";
import type { PptxPreviewState } from "./usePptxPreview.js";

export function usePptxPageRender(input: {
  preview: PptxPreviewState;
  pageIndex: number;
  partName: string;
  renderKey: number;
}): { hostRef: RefObject<HTMLDivElement | null>; measured: Record<string, CanvasBox> } {
  const { preview, pageIndex, partName, renderKey } = input;
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** 渲染器实测的形状框（XML 里没有显式几何的用它兜底）。 */
  const [measured, setMeasured] = useState<Record<string, CanvasBox>>({});

  // 画当前页（文档换了、换页、或这一页被改过就重画）
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
  }, [preview, pageIndex, partName, renderKey]);

  useEffect(() => {
    let elements: Parameters<typeof measuredBoxesOf>[0] = [];
    try {
      elements = preview.document?.getPageElements(pageIndex) ?? [];
    } catch {
      // 文档正在被换掉（改动后重算预览）：这一帧先不给兜底几何，下一帧就好了
      elements = [];
    }
    setMeasured(measuredBoxesOf(elements));
  }, [preview, pageIndex]);

  return { hostRef, measured };
}
