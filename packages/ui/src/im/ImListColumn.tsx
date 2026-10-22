import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { IM_LIST_OVERLAY_BACKDROP } from "./imChrome.js";
import type { ImListColumnState } from "./imPresentation.js";

/**
 * 左侧列表列：停靠 / 浮层 / 不显示三种形态（形态由 `imListColumnState` 算，这里只负责画）。
 *
 * 抽出来的理由：浮层的**定位与背板**必须和列表同生同死——分开写会出现"背板在、列表不在"这种
 * 点一下整块面板没反应的状态（联调时最难查）。放在一个组件里，形态与结构就不可能有偏差。
 */
export function ImListColumn({
  state,
  backdropLabel,
  onBackdrop,
  children,
}: {
  state: ImListColumnState;
  backdropLabel: string;
  onBackdrop: () => void;
  children: ReactNode;
}) {
  return (
    <>
      {state.backdrop ? (
        <button
          type="button"
          aria-label={backdropLabel}
          data-testid="im-list-overlay-backdrop"
          className={IM_LIST_OVERLAY_BACKDROP}
          onClick={onBackdrop}
        />
      ) : null}
      <div
        data-testid="im-list-column"
        data-mode={state.mode}
        className={cn(
          "flex shrink-0 flex-col border-r border-border",
          state.widthClass,
          state.mode === "overlay" ? "absolute inset-y-0 left-0 z-30 shadow-2xl" : "relative",
          state.mode === "hidden" && "hidden",
        )}
      >
        {children}
      </div>
    </>
  );
}
