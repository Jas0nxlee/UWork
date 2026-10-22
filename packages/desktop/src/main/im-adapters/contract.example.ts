import type { AppBadgeWriter } from "./contract.js";

/** 调用方传入同一个 Main writer，不创建第二份角标状态。 */
export function exampleUnreadUpdate(writer: AppBadgeWriter): number {
  writer.setTaskUnreadBadgeCount(3);
  return writer.setImUnreadBadgeCount(2);
}
