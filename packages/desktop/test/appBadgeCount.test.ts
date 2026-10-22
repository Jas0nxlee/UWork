import { describe, expect, it } from "vitest";
import { combineAppBadgeCount } from "../src/main/unreadBadge.js";

// 角标只有一个数字、却有两处来源（任务未读、IM 未读），谁后写谁生效就会互相抹掉。
// 这个纯函数是两者唯一的交汇点，所以单独钉住它的求和与边界。
describe("combineAppBadgeCount", () => {
  it("把任务未读与 IM 未读求和，任一为 0 时不吞掉另一侧", () => {
    expect(combineAppBadgeCount(0, 0)).toBe(0);
    expect(combineAppBadgeCount(3, 0)).toBe(3);
    expect(combineAppBadgeCount(0, 5)).toBe(5);
    expect(combineAppBadgeCount(2, 3)).toBe(5);
  });

  it("负数按 0 计、小数截断（角标只接受非负整数）", () => {
    expect(combineAppBadgeCount(-2, 1)).toBe(1);
    expect(combineAppBadgeCount(1, -3)).toBe(1);
    expect(combineAppBadgeCount(1.9, 2.9)).toBe(3);
    expect(combineAppBadgeCount(Number.NaN, 4)).toBe(4);
  });
});
