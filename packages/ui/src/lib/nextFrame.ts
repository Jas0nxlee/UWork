/**
 * "下一帧"调度器：保证回调一定会执行。
 *
 * 为什么不能直接用 `requestAnimationFrame`：**窗口被遮挡或最小化时 Chromium 暂停渲染，
 * rAF 回调不会触发**（不是延迟，是这个回调被丢掉了）。只要某段状态是"只在 rAF 里提交"，
 * 那次提交就永久丢失——面板停在不可见、粘性表头停在透明、toast 停在没有进入态，
 * 而且恢复窗口也回不来，因为触发它的事件已经过去了。
 *
 * 三种情形分别处理：
 * - 页面不可见：rAF 不可指望，**同步执行**（异步兜底也会被隐藏页面的定时器节流拖到分钟级）。
 * - 页面可见：走 rAF（保持"布局完成后再读/写"的语义），另加一个定时器兜底，
 *   防止"刚排上队窗口就被遮挡/切到后台"这种竞态。谁先到谁执行，另一个取消。
 * - 主动 cancel：两条路都不再执行。
 */
export interface RunOnNextFrameOptions {
  /** 兜底定时器；默认 250ms（60fps 下相当于 15 帧，正常永远走 rAF）。 */
  fallbackMs?: number;
  /** 便于测试注入；默认取 `document.visibilityState`。 */
  visibilityState?: DocumentVisibilityState | undefined;
}

const DEFAULT_FALLBACK_MS = 250;

export function runOnNextFrame(
  callback: () => void,
  options: RunOnNextFrameOptions = {},
): () => void {
  const visibilityState =
    options.visibilityState ??
    (typeof document === "undefined" ? "visible" : document.visibilityState);

  if (visibilityState === "hidden") {
    callback();
    return () => undefined;
  }

  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    cleanup();
    callback();
  };

  // jsdom 默认没有 rAF；没有就直接用定时器，别让调用方崩在"下一帧"上。
  const hasFrame = typeof window.requestAnimationFrame === "function";
  const frame = hasFrame ? window.requestAnimationFrame(run) : undefined;
  const timer = window.setTimeout(run, options.fallbackMs ?? DEFAULT_FALLBACK_MS);

  function cleanup(): void {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  }

  return () => {
    done = true;
    cleanup();
  };
}
