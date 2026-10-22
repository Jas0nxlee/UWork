import { app } from "electron";
import { combineAppBadgeCount, supportsAppUnreadBadge } from "./unreadBadge.js";

/**
 * Dock / 任务栏角标的**唯一写入点**。
 *
 * 为什么不能各写各的：任务未读（工作区）和 IM 未读（消息）是两个独立来源，谁后写谁生效——
 * 任务侧一次 sync 就会把 IM 的数字抹掉，反之亦然。这里同时持有两份计数，
 * 任何一侧更新都按求和重写，两边的数字就不会互相吃掉。
 */
let taskUnreadCount = 0;
let imUnreadCount = 0;

function apply(): number {
  if (!supportsAppUnreadBadge(process.platform)) return 0;
  const count = combineAppBadgeCount(taskUnreadCount, imUnreadCount);
  app.setBadgeCount(count);
  return count;
}

export function setTaskUnreadBadgeCount(count: number): void {
  taskUnreadCount = count;
  apply();
}

/** 返回宿主实际写回的数字，调用方（渲染层）据此判断角标是否被接受。 */
export function setImUnreadBadgeCount(count: number): number {
  imUnreadCount = count;
  return apply();
}
