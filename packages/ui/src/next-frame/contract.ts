/** 既有帧调度入口的可注入选项。 */
export interface RunOnNextFrameOptions {
  /** 可见页面的备用定时器；默认 250ms。 */
  fallbackMs?: number;
  /** 测试注入；默认读取 document.visibilityState。 */
  visibilityState?: DocumentVisibilityState | undefined;
}

/** 每次调用仅执行一次；取消后不再执行。隐藏页面可同步完成。 */
export type NextFrameScheduler = (
  callback: () => void,
  options?: RunOnNextFrameOptions,
) => () => void;
