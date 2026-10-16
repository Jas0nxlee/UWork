/**
 * 版面（纸张/页边距/方向/分栏）的**快照与恢复**，以及"哪些命令会改版面"。
 *
 * 为什么要单独记快照：引擎的撤销栈存的是**元素表快照**，版面配置挂在 `options` 上、不进元素表，
 * 所以改完版面按 Ctrl+Z 什么都不会发生（真机反馈"插入分栏没法撤销"）。撤销时先让引擎撤文本、
 * 引擎撤不动了再撤版面（与操作顺序一致）。
 */
import type { EngineCommand } from "./engineCommands.js";

export interface LayoutState {
  width?: number;
  height?: number;
  margins?: number[];
  paperDirection?: string;
  columns: unknown;
}

export interface LayoutHistory {
  undo: LayoutState[];
  redo: LayoutState[];
}

export function createLayoutHistory(): LayoutHistory {
  return { undo: [], redo: [] };
}

/** 读当前版面（引擎的 getOptions 里有纸张/页边距/方向，分栏要单独问 getColumns）。 */
export function readLayout(commands: EngineCommand): LayoutState | null {
  const getOptions = commands.getOptions as
    | (() => { width?: number; height?: number; margins?: number[]; paperDirection?: string })
    | undefined;
  const options = getOptions?.();
  if (!options) return null;
  const getColumns = commands.getColumns as (() => unknown) | undefined;
  return {
    width: options.width,
    height: options.height,
    margins: options.margins,
    paperDirection: options.paperDirection,
    columns: getColumns?.() ?? null,
  };
}

/** 把版面恢复成快照（用引擎自己的命令，避免直接改 options 造成状态不一致）。 */
export function applyLayout(commands: EngineCommand, layout: LayoutState): void {
  if (typeof layout.width === "number" && typeof layout.height === "number") {
    commands.executePaperSize?.(layout.width, layout.height);
  }
  if (layout.margins) commands.executeSetPaperMargin?.(layout.margins);
  commands.executeSetColumns?.(layout.columns ?? null);
  if (layout.paperDirection) commands.executePaperDirection?.(layout.paperDirection);
}

/** 会改变版面的命令：执行前记一份快照，供"撤版面"使用。 */
export const LAYOUT_COMMANDS = new Set([
  "executeSetColumns",
  "executePaperSize",
  "executePaperDirection",
  "executeSetPaperMargin",
]);
