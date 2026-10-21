import { useCallback, useEffect, useRef, useState } from "react";
import { MessagesSquareIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { IM_EMPTY, IM_EMPTY_ICON, IM_EMPTY_TEXT, IM_PANEL } from "./imChrome.js";

/** 面板级的小工具：宽度观察（面板可拖动，布局要跟实际宽度走）与统一的空态。 */

/** 与 `ResizeObserverEntry.contentRect` 同口径（去掉补白与边框）。 */
function contentWidth(node: HTMLElement): number {
  const style = getComputedStyle(node);
  const inner =
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0) +
    (parseFloat(style.borderLeftWidth) || 0) +
    (parseFloat(style.borderRightWidth) || 0);
  return Math.round(Math.max(0, node.getBoundingClientRect().width - inner));
}

/**
 * 观察某个元素的宽度；侧边面板可被拖动，布局要跟着**面板实际宽度**走而不是窗口宽度。
 *
 * 为什么用回调 ref，而不是 `useRef` + `useEffect(..., [ref])`：面板在"未加载 / 无权限 / 不在白名单"
 * 这三种情况下渲染的是空态，**被测的那个 div 首帧并不存在**；只跑一次的 effect 会在
 * `ref.current === null` 时直接返回、之后再也不会重试，宽度就永远是 0——而 `imPaneBand(0)` 会
 * 兜底成 `medium`，于是"拖窄自动折叠列表"整个失效，且看不出任何报错。
 * 真机复现过：面板实测 774px，`data-pane-width` 却是 0，拖到 600 也不折叠。
 *
 * 首帧立刻量一次再交给 observer：`ResizeObserver` 的首次回调是异步的，只等它会先按 0 渲一帧。
 */
export function useElementWidth(): {
  measureRef: (node: HTMLElement | null) => void;
  width: number;
} {
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    setWidth(contentWidth(node));
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  return { measureRef, width };
}

export function ImNotice({ text }: { text: string }) {
  return (
    <div className={cn(IM_EMPTY, IM_PANEL)}>
      <MessagesSquareIcon className={IM_EMPTY_ICON} />
      <p className={IM_EMPTY_TEXT}>{text}</p>
    </div>
  );
}
