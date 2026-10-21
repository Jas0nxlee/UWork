/** 画布底部那条提示的话（选中了什么、能不能拖、在不在页面外）。单独成文件只为守住画布的 400 行。 */
import type { CanvasBox } from "./pptCanvasGeometry.js";

export function canvasHint(input: {
  activeShape: string | null;
  activeBox: CanvasBox | null;
  known: boolean;
  offPage: boolean;
}): string {
  const { activeShape, activeBox, known, offPage } = input;
  if (!known || !activeShape) return "点形状选中，拖动移动，拉四角缩放";
  if (!activeBox)
    return `「${activeShape}」的位置大小继承自版式，先在右侧窗格里填一次，之后就能在画布上拖`;
  if (offPage) {
    return `「${activeShape}」整块在页面外：拉页边的手柄拖回来，或在右侧窗格里改 X/Y`;
  }
  const cm = (emu: number) => Math.round(emu / 3600) / 100;
  return `已选中「${activeShape}」 · ${cm(activeBox.width)} × ${cm(activeBox.height)} 厘米`;
}
