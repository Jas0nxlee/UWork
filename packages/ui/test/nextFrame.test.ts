// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOnNextFrame } from "@/lib/nextFrame.js";

const setVisibility = (state: DocumentVisibilityState): void => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
};

/** 可控的 rAF：默认像真浏览器一样下一帧执行，测试可以改成"永不触发"（被遮挡的窗口就是这样）。 */
function installFrameStub({ autoRun = true } = {}): {
  callbacks: Array<() => void>;
  cancelled: number;
  pending: number;
} {
  const callbacks: Array<() => void> = [];
  const state = {
    cancelled: 0,
    get pending() {
      return callbacks.length;
    },
  };
  const real = window.requestAnimationFrame;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    if (!autoRun) {
      callbacks.push(() => callback(0));
      return callbacks.length;
    }
    callbacks.push(() => callback(0));
    const id = callbacks.length;
    queueMicrotask(() => {
      // 模拟"下一帧"：宏任务里执行，保证与 setTimeout 兜底的先后可控
      setTimeout(() => callbacks[id - 1]?.(), 0);
    });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    state.cancelled += 1;
  });
  void real;
  return {
    callbacks,
    get cancelled() {
      return state.cancelled;
    },
    get pending() {
      return callbacks.length;
    },
  };
}

beforeEach(() => {
  setVisibility("visible");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runOnNextFrame：保证回调一定会执行", () => {
  it("页面可见时走 rAF", async () => {
    installFrameStub();
    const callback = vi.fn();
    runOnNextFrame(callback);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("rAF 永不触发（窗口被遮挡）时靠兜底定时器执行", async () => {
    vi.useFakeTimers();
    installFrameStub({ autoRun: false });
    const callback = vi.fn();
    runOnNextFrame(callback, { fallbackMs: 200 });
    expect(callback).not.toHaveBeenCalled(); // rAF 挂在那儿不动
    await vi.advanceTimersByTimeAsync(250);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("已经不可见时同步执行，不等 rAF 也不等定时器", () => {
    setVisibility("hidden");
    const frame = installFrameStub({ autoRun: false });
    const callback = vi.fn();
    runOnNextFrame(callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(frame.pending).toBe(0); // 压根没去排 rAF
  });

  it("取消之后两条路都不执行", async () => {
    vi.useFakeTimers();
    installFrameStub({ autoRun: false });
    const callback = vi.fn();
    const cancel = runOnNextFrame(callback, { fallbackMs: 100 });
    cancel();
    await vi.advanceTimersByTimeAsync(500);
    const frame = installFrameStub({ autoRun: false });
    frame.callbacks.forEach((run) => run());
    expect(callback).not.toHaveBeenCalled();
  });

  it("rAF 先到时兜底定时器不会再执行第二次", async () => {
    vi.useFakeTimers();
    const frame = installFrameStub({ autoRun: false });
    const callback = vi.fn();
    runOnNextFrame(callback, { fallbackMs: 100 });
    frame.callbacks.forEach((run) => run());
    await vi.advanceTimersByTimeAsync(500);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
