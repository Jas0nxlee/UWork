import type { NextFrameScheduler } from "./contract.js";

/** 面板挂载时排一次布局更新，卸载时调用返回的取消函数。 */
export function exampleNextFrame(
  schedule: NextFrameScheduler,
  updateLayout: () => void,
): () => void {
  return schedule(updateLayout);
}
