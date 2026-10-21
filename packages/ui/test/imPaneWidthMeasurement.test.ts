// @vitest-environment jsdom
import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useElementWidth } from "@/im/imPaneChrome.js";
import { imListColumnState, imPaneBand } from "@/im/imPresentation.js";

/**
 * 面板宽度观察的回归测试。
 *
 * 真机事故：消息面板"拖窄自动折叠左侧列表"失效。根因不是档位算法，而是**宽度没被量到**——
 * 面板在加载态 / 无权限时渲染的是空态，被测 div 首帧不存在，而当时的 effect 只跑一次
 * （依赖 `[ref]`），`ref.current === null` 就直接返回、不再重试，宽度永远是 0；
 * `imPaneBand(0)` 又兜底成 `medium`，于是永远"停靠"。
 * 这里把"元素晚出现也要量到"和"拖动要跟着变"两件事都钉住。
 */

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.observed.length = 0;
  }
  /** 模拟拖动面板：observer 回报新的内容宽度。 */
  emit(width: number): void {
    const target = this.observed[0];
    if (!target) throw new Error("emit 前必须先 observe");
    this.callback(
      [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

/** 量宽度用的假元素宽度（jsdom 里没有真实布局）。 */
let elementWidth = 0;

function Probe() {
  const { measureRef, width } = useElementWidth();
  const [mounted, setMounted] = useState(false);
  // 复刻面板的形状：先渲染空态（没有被测元素），数据到位后才渲染面板那一层
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "width" }, String(width)),
    mounted ? createElement("div", { ref: measureRef, "data-testid": "pane" }) : null,
    createElement(
      "button",
      { type: "button", "data-testid": "mount", onClick: () => setMounted(true) },
      "mount",
    ),
  );
}

beforeEach(() => {
  elementWidth = 0;
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width: elementWidth,
        height: 0,
        top: 0,
        left: 0,
        right: elementWidth,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("面板宽度观察", () => {
  it("元素晚于首帧出现时也要量到宽度（不能停在 0）", () => {
    const { getByTestId } = render(createElement(Probe));
    // 空态阶段：还没有被测元素，宽度保持 0（此时面板根本没渲染列表）
    expect(getByTestId("width").textContent).toBe("0");

    elementWidth = 774;
    act(() => {
      getByTestId("mount").click();
    });

    // 关键断言：元素一出现就量到真实宽度，而不是永远 0（旧实现这里会停在 0）
    expect(getByTestId("width").textContent).toBe("774");
    expect(FakeResizeObserver.instances.at(-1)?.observed).toHaveLength(1);
  });

  it("拖动面板时宽度跟着 observer 更新，档位随之切换", () => {
    elementWidth = 960;
    const { getByTestId } = render(createElement(Probe));
    act(() => {
      getByTestId("mount").click();
    });
    expect(imPaneBand(Number(getByTestId("width").textContent))).toBe("wide");

    act(() => {
      FakeResizeObserver.instances.at(-1)?.emit(656);
    });
    const narrow = Number(getByTestId("width").textContent);
    expect(narrow).toBe(656);
    expect(imPaneBand(narrow)).toBe("narrow");
    // 窄档 + 未主动打开 → 列表不占栏（这就是"自动收起"）
    expect(
      imListColumnState({ band: "narrow", listOverlayOpen: false, railView: "messages" }),
    ).toEqual({
      mode: "hidden",
      widthClass: "w-64",
      backdrop: false,
    });
    // 窄档 + 主动打开 → 浮层 + 背板
    expect(
      imListColumnState({ band: "narrow", listOverlayOpen: true, railView: "messages" }).mode,
    ).toBe("overlay");
  });

  it("初始测量与 contentRect 同口径：补白/边框不算进面板宽度", () => {
    elementWidth = 700;
    const { getByTestId } = render(createElement(Probe));
    const padding = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      paddingLeft: "12px",
      paddingRight: "8px",
      borderLeftWidth: "1px",
      borderRightWidth: "1px",
    } as unknown as CSSStyleDeclaration);
    act(() => {
      getByTestId("mount").click();
    });
    padding.mockRestore();
    // 700 - (12 + 8 + 1 + 1) = 678
    expect(getByTestId("width").textContent).toBe("678");
  });
});
