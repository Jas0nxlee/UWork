// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";

const setVisibility = (state: DocumentVisibilityState): void => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setVisibility("visible");
});

describe("面板展开不依赖那一帧", () => {
  it("窗口被遮挡时打开面板，仍然会切到可见（rAF 在这种窗口里不触发）", () => {
    setVisibility("hidden");
    // 把 rAF 换成"永远不执行"的桩，模拟被遮挡窗口里的真实行为
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useAnimatedResizablePanel({ open }),
      { initialProps: { open: false } },
    );
    expect(result.current.isVisible).toBe(false);

    act(() => {
      rerender({ open: true });
    });
    expect(result.current.isVisible).toBe(true);
    vi.unstubAllGlobals();
  });

  it("rAF 被丢弃（排上队之后窗口才被遮挡）时，兜底定时器仍然把它切到可见", async () => {
    setVisibility("visible");
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useAnimatedResizablePanel({ open }),
      { initialProps: { open: false } },
    );
    act(() => {
      rerender({ open: true });
    });
    expect(result.current.isVisible).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.isVisible).toBe(true);
    vi.unstubAllGlobals();
  });

  it("关闭面板时立即回到不可见（不依赖任何帧）", () => {
    setVisibility("hidden");
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useAnimatedResizablePanel({ open }),
      { initialProps: { open: true } },
    );
    expect(result.current.isVisible).toBe(true);
    act(() => {
      rerender({ open: false });
    });
    expect(result.current.isVisible).toBe(false);
  });
});
