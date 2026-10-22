export type { SaveImAttachmentRequest, SaveImAttachmentResult } from "@zcode/shared";

/** Main 的既有角标写入点；任务与 IM 计数只能在此汇合。 */
export interface AppBadgeWriter {
  setTaskUnreadBadgeCount(count: number): void;
  setImUnreadBadgeCount(count: number): number;
}
