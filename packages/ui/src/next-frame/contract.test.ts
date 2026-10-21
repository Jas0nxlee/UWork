// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOnNextFrame } from "../lib/nextFrame.js";
import { exampleNextFrame } from "./contract.example.js";
import type { NextFrameScheduler } from "./contract.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("next-frame 公开调度契约", () => {
  it("真实调度器支持示例返回取消函数，取消后没有延迟提交", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);
    const schedule: NextFrameScheduler = (callback) =>
      runOnNextFrame(callback, { visibilityState: "visible" });
    const update = vi.fn();
    const cancel = exampleNextFrame(schedule, update);
    cancel();
    cancel();
    vi.runAllTimers();
    expect(update).not.toHaveBeenCalled();
  });

  it("隐藏页面无需等待渲染即可完成状态提交", () => {
    const update = vi.fn();
    const schedule: NextFrameScheduler = (callback) =>
      runOnNextFrame(callback, { visibilityState: "hidden" });
    exampleNextFrame(schedule, update)();
    expect(update).toHaveBeenCalledOnce();
  });
});
