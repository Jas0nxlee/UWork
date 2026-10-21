/**
 * 缩放时的**视口锚点**计算（纯函数，便于回归检查）。
 *
 * 为什么需要它：引擎的容器宽度＝纸张宽 × 缩放（`getWidth() = getOriginalWidth() * scale`），
 * 页面居中由外层的 `mx-auto` 负责；但缩放后浏览器只会把滚动位置**原样保留**，
 * 于是视图会跳到文档左上角（真机反馈："页面缩放后没有自动居中，以左上角为 point 缩放"）。
 * 这里按缩放比例把滚动位置一起换算，让人盯着的那块内容留在视线里；内容比视口窄时横向归零
 * （交给 `mx-auto` 居中）。
 */
export interface ZoomScrollInput {
  scrollTop: number;
  scrollLeft: number;
  /** 滚动容器可见区域（clientWidth/clientHeight）。 */
  viewportWidth: number;
  viewportHeight: number;
  /** 缩放**之后**的内容尺寸（纸张宽×新缩放、所有页面高之和＋页间距）。 */
  contentWidth: number;
  contentHeight: number;
  prevScale: number;
  nextScale: number;
}

export interface ZoomScrollResult {
  scrollTop: number;
  scrollLeft: number;
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, Math.max(0, max));
}

export function scrollAfterZoom(input: ZoomScrollInput): ZoomScrollResult {
  const { prevScale, nextScale } = input;
  const ratio = prevScale > 0 ? nextScale / prevScale : 1;
  const maxTop = input.contentHeight - input.viewportHeight;
  const maxLeft = input.contentWidth - input.viewportWidth;
  // 内容比视口窄/矮时没有滚动余地：横向归零让 mx-auto 居中，纵向回到顶部
  const scrollLeft = maxLeft <= 0 ? 0 : clamp(input.scrollLeft * ratio, maxLeft);
  const scrollTop = maxTop <= 0 ? 0 : clamp(input.scrollTop * ratio, maxTop);
  return { scrollLeft, scrollTop };
}

/** 纸张在容器里的水平偏移（居中判定用）：容器比纸张宽时，左侧留白应当是半个差值。 */
export function horizontalInset(contentWidth: number, viewportWidth: number): number {
  return Math.max(0, (viewportWidth - contentWidth) / 2);
}
