/**
 * PPT 编辑位的**调试/自动化口子**（挂在 `globalThis.__pptxPane`）。
 *
 * 与 Word/Excel 编辑位同款：真机排查和自动化都靠它读"界面现在是什么状态"。
 * 单独成文件的原因：它属于测试脚手架，不该占编辑位（那个文件有 400 行上限）。
 */
import type { PptxShape } from "./pptShapes.js";

export interface PptxPaneDebugInput {
  slideCount: () => number;
  /** 当前页的形状（读的是当前 XML，不是 React state）。 */
  shapes: () => PptxShape[];
  activePartName: () => string | null;
  /** 预览重算次数 / 最后一次错误（排查"改了画布没动"）。 */
  previewBuilds: () => number;
  previewError: () => string | null;
  /** 当前喂给渲染器的字节（拷贝）：自动化里解包看它到底有没有那张图。 */
  previewBytes: () => ArrayBuffer | null;
  /** 模型里某一页的 XML（排查"模型改了、字节没改"）。 */
  modelXml: (partName: string) => string | null;
}

export function installPptxPaneDebug(input: PptxPaneDebugInput): () => void {
  const global = globalThis as Record<string, unknown>;
  const findShape = (name: string): PptxShape | null =>
    input.shapes().find((item) => item.name === name) ?? null;
  global.__pptxPane = {
    slideCount: () => input.slideCount(),
    previewBuilds: () => input.previewBuilds(),
    previewError: () => input.previewError(),
    previewBytes: () => input.previewBytes(),
    modelXml: (partName: string) => input.modelXml(partName),
    shapeNames: () => input.shapes().map((item) => item.name),
    shapeBounds: (name: string) => {
      const found = findShape(name);
      return found ? found.bounds.width : null;
    },
    /** 形状的完整几何（EMU）：画布断言按它算"该点在哪儿"。 */
    shapeBox: (name: string) => {
      const found = findShape(name);
      return found ? { ...found.bounds } : null;
    },
    /** 画布状态：渲染出来了没 / 选中哪个形状 / 选框与手柄在不在 / 是不是在就地改字。 */
    canvas: () => {
      const frame = document.querySelector("[data-pptx-canvas-frame]");
      if (!frame) return null;
      const selection = document.querySelector("[data-pptx-canvas-selection]");
      const host = frame.querySelector("[data-pptx-canvas-host]");
      const layer = frame.querySelector("[data-pptx-canvas-layer]");
      const editor = document.querySelector("[data-pptx-text-editor]");
      const rect = (node: Element | null) => {
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { left: box.left, top: box.top, width: box.width, height: box.height };
      };
      return {
        ready: frame.getAttribute("data-pptx-canvas-ready") === "true",
        scale: Number(frame.getAttribute("data-pptx-canvas-scale") ?? 0),
        zoom: Number(frame.getAttribute("data-pptx-canvas-zoom") ?? 0),
        pageWidth: Number(frame.getAttribute("data-pptx-canvas-page-width") ?? 0),
        renderedNodes: host ? host.childElementCount : 0,
        selected: selection?.getAttribute("data-pptx-canvas-selection") ?? null,
        handles: frame.querySelectorAll("[data-pptx-canvas-handle]").length,
        editingText: Boolean(editor),
        editorFontSize: editor ? getComputedStyle(editor as Element).fontSize : null,
        frame: rect(frame),
        layer: rect(layer),
        selectionRect: rect(selection),
      };
    },
    /** 左栏缩略图面板：缩略图画出来几张、当前页高亮在第几个。 */
    thumbnails: () => {
      const panel = document.querySelector("[data-pptx-slide-panel]");
      if (!panel) return null;
      const items = [...panel.querySelectorAll("[data-pptx-slide]")];
      return {
        count: items.length,
        rendered: items.filter((item) => {
          const host = item.querySelector("[data-pptx-thumb-host]");
          return host ? host.childElementCount > 0 : false;
        }).length,
        active: items.findIndex((item) => item.getAttribute("data-pptx-slide-active") === "true"),
      };
    },
  };
  return () => {
    if (global.__pptxPane) global.__pptxPane = undefined;
  };
}
