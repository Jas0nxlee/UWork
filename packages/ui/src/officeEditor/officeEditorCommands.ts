/**
 * 功能区的语义命令 → canvas-editor 引擎命令。
 *
 * 与 engineCommands.ts 的分工：那边是"参数长什么样"（纯函数、可单测），这里是"命令怎么调度"
 * （要读当前状态、要维护查找会话、要在命令后同步布局状态）。
 */
import katex from "katex";
import {
  controlPayload,
  dateControlPayload,
  documentText,
  latexElement,
  PAPER_PRESETS,
  singleCheckboxPayload,
  textStats,
  type EngineCommand,
} from "./engineCommands.js";
import type { IElement } from "./engineTypes.js";

/**
 * 功能区命令入口：把 ribbon 的语义命令映射到引擎命令。
 *
 * 单独一个文件的原因有两个：编辑位本体已经接近仓库 400 行上限；更重要的是这些映射**全是实测出来的
 * 参数形态与坑**（纸张收像素、控件要整套 valueSets、连页是 "continuity"、引擎没有字数统计命令…），
 * 集中在一处才好对照 engineCommands.ts 的注释。
 */
/**
 * 版面状态（纸张/页边距/方向/分栏）。
 *
 * 为什么要自己做撤销：引擎的撤销栈存的是**元素表快照**（`historyManager.execute(fn)`），
 * 而分栏/纸张这些是 `options` 上的版面配置，不进元素表——所以改完版面按 Ctrl+Z 什么都不会发生
 * （真机反馈"最右边的插入分栏没法撤销"）。这里给版面单独记一份快照栈，撤销时先让引擎撤文本、
 * 引擎撤不动了再撤版面（与用户的心智一致：最后做的先回退）。
 */
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

export interface CommandContext {
  /** 引擎实例（需要 `command`，替换还要读内部元素表）。 */
  editor: { command: Record<string, unknown>; draw?: unknown };
  commands: EngineCommand;
  status: (message: string) => void;
  /** 当前编辑器状态：只读/页面模式要在命令之间翻转。 */
  engineState: { mode: string; pageMode: string };
  /** 查找会话：关键词、命中下标与当前位置（跨命令保留）。 */
  findRef: { current: FindSession };
  /** 版面撤销栈（纸张/页边距/方向/分栏）。 */
  layoutRef?: { current: LayoutHistory };
  /** 引擎自己还能不能撤销/重做（由编辑位从 rangeStyleChange 里回填；决定"该撤文本还是撤版面"）。 */
  canUndoEngine?: () => boolean;
  canRedoEngine?: () => boolean;
}

/** 会改变版面的命令：执行前记一份快照，供"撤版面"使用。 */
const LAYOUT_COMMANDS = new Set([
  "executeSetColumns",
  "executePaperSize",
  "executePaperDirection",
  "executeSetPaperMargin",
]);

export interface FindSession {
  keyword: string;
  /** 命中范围：由引擎 `getKeywordRangeList` 给出（含表格单元格坐标），我们不自己算下标。 */
  ranges: Array<Record<string, unknown>>;
  current: number;
}

export function createFindSession(): FindSession {
  return { keyword: "", ranges: [], current: -1 };
}

export function runEngineCommand(context: CommandContext, command: string, args?: unknown[]): void {
  const { editor, commands, status, engineState, findRef } = context;
  // 版面类命令先记快照：执行成功与否都要能退回上一种版面（引擎的元素表历史管不到版面）
  if (LAYOUT_COMMANDS.has(command) && context.layoutRef) {
    const before = readLayout(commands);
    if (before) {
      context.layoutRef.current.undo.push(before);
      context.layoutRef.current.redo.length = 0;
    }
  }
  try {
    switch (command) {
      case "executeInsertControlByType": {
        commands.executeInsertControl?.(controlPayload(String(args?.[0] ?? "text")));
        break;
      }
      case "executeInsertCheckboxControl": {
        commands.executeInsertControl?.(singleCheckboxPayload());
        break;
      }
      case "executeInsertDateControl": {
        commands.executeInsertControl?.(dateControlPayload());
        break;
      }
      case "executeInsertTable": {
        const [rows, cols] = args as [number, number];
        commands.executeInsertTable?.(rows, cols);
        status(`已插入 ${rows}×${cols} 表格`);
        break;
      }
      case "executeSetTableCellBackgroundColor": {
        commands.executeTableTdBackgroundColor?.(args?.[0]);
        break;
      }
      case "executeSetTableCellVerticalAlign": {
        commands.executeTableTdVerticalAlign?.(args?.[0]);
        break;
      }
      case "executeImage": {
        // 官方 demo 从 <img> 载入宽高；这里给一个稳妥的默认尺寸，用户可在文档里拖拽调整。
        commands.executeImage?.({ value: args?.[0] ?? "", width: 320, height: 240 });
        break;
      }
      case "executeHyperlink": {
        const url = String(args?.[0] ?? "");
        if (!url) break;
        commands.executeHyperlink?.({ url, valueList: [{ value: url, size: 16 }] });
        break;
      }
      case "executeLatex": {
        const value = String(args?.[0] ?? "");
        if (!value) break;
        // 引擎不认 LaTeX 源码：要先用 katex 渲染成 SVG，再插 latex 元素（官方 demo 同做法）。
        const svg = katex.renderToString(value, { throwOnError: false, output: "mathml" });
        const html = katex.renderToString(value, { throwOnError: false });
        commands.executeInsertElementList?.([latexElement(html || svg)] as IElement[]);
        break;
      }
      case "executeAddWatermark": {
        const data = String(args?.[0] ?? "") || "UWork";
        commands.executeAddWatermark?.({
          data,
          color: "#d0d0d0",
          size: 100,
          opacity: 0.3,
          repeat: true,
        });
        break;
      }
      case "executePaperSize": {
        // 引擎的 paperSize(width, height) 收**像素**；传 "A4" 会把页面尺寸写成 NaN → 整页空白（真机反馈）。
        const preset = PAPER_PRESETS[String(args?.[0] ?? "")];
        if (preset) commands.executePaperSize?.(preset.width, preset.height);
        break;
      }
      case "executePageScale": {
        commands.executePageScale?.(Number(args?.[0] ?? 1));
        break;
      }
      case "executePageMode": {
        // 引擎的枚举是 paging / continuation… 实际是 "paging" | "continuity"；
        // 之前拿 "continuous" 去比，导致切到连页后**再也切不回来**（真机反馈"不能用"）。
        const next = engineState.pageMode === "continuity" ? "paging" : "continuity";
        commands.executePageMode?.(next);
        status(next === "paging" ? "已切到分页视图（每页一张纸）" : "已切到连页视图（滚动连续）");
        break;
      }
      case "executeToggleTrace": {
        // toggleTrace(payload) 的 payload 是"是否显示痕迹"（不是 disabled），无参会读当前值取反。
        commands.executeToggleTrace?.();
        break;
      }
      case "executeMode": {
        commands.executeMode?.(engineState.mode === "readonly" ? "edit" : "readonly");
        break;
      }
      case "executeWordCount": {
        void (async () => {
          const getValue = editor.command.getValue as (() => { data?: never }) | undefined;
          const text = documentText(
            (getValue?.() as { data?: never } | undefined)?.data ?? undefined,
          );
          const stats = textStats(text);
          const getWordCount = editor.command.getWordCount as (() => Promise<number>) | undefined;
          const words = await getWordCount?.();
          status(
            `字数 ${words ?? "—"} · 字符（不含空白）${stats.chars} · 段落 ${stats.paragraphs}`,
          );
        })().catch((error) => status(`字数统计失败：${String(error)}`));
        break;
      }
      case "executeFind": {
        const keyword = String(args?.[0] ?? "");
        if (!keyword) {
          commands.executeSearch?.(null);
          findRef.current = { keyword: "", ranges: [], current: -1 };
          status("请输入要查找的内容");
          break;
        }
        // 引擎的 `getKeywordRangeList` 用**引擎自己的**匹配器给出可交给 setRange 的范围
        // （表格里的命中还带 tableId/行列坐标）——比我们猜元素下标可靠得多。
        const ranges = getKeywordRanges(editor, keyword) ?? [];
        findRef.current = { keyword, ranges, current: ranges.length ? 0 : -1 };
        commands.executeSearch?.(keyword);
        highlightCurrentHit(editor, status, findRef.current);
        break;
      }
      case "executeFindNext":
      case "executeFindPrev": {
        const session = findRef.current;
        if (!session.ranges.length) {
          status("先输入要查找的内容");
          break;
        }
        const step = command === "executeFindNext" ? 1 : -1;
        session.current = (session.current + step + session.ranges.length) % session.ranges.length;
        highlightCurrentHit(editor, status, session);
        break;
      }
      case "executeReplaceOne":
      case "executeReplaceAll": {
        const [keyword, replacement] = args as [string, string];
        if (!keyword) {
          status("先输入要替换的内容");
          break;
        }
        const all = command === "executeReplaceAll";
        // 一次取全部命中，**从后往前**替换：改动后面的元素不会影响前面的下标，
        // 所以不需要"替换一轮重取一轮"——那样在"替换词包含查找词"时会无限增长
        // （实测：把"压测"替换成"压测证"时，每轮都能重新找到命中，直到撞上限）。
        const ranges = (getKeywordRanges(editor, keyword) ?? []).slice().reverse();
        const targets = all ? ranges : ranges.slice(-1);
        let done = 0;
        let skipped = 0;
        for (const range of targets) {
          selectMatch(commands, range);
          // 复核：选中的确实是关键词，否则跳过——绝不"替换错地方"。
          const selected = (commands.getRangeText as (() => string) | undefined)?.();
          if (selected !== keyword) {
            skipped += 1;
            continue;
          }
          commands.executeInsertElementList?.([{ value: replacement }]);
          done += 1;
        }
        if (!ranges.length) {
          status(`未找到「${keyword}」`);
          break;
        }
        status(
          `已替换 ${done} 处${skipped ? ` · 跳过 ${skipped} 处（位置无法确认）` : ""}${
            replacement ? "" : "（替换为空＝删除）"
          }`,
        );
        break;
      }
      case "executeUndo":
      case "executeRedo": {
        const redo = command === "executeRedo";
        const engineCan = redo ? context.canRedoEngine?.() : context.canUndoEngine?.();
        const history = context.layoutRef?.current;
        const stack = redo ? history?.redo : history?.undo;
        // 引擎的元素表历史优先（文本编辑），撤不动了再撤版面——顺序与用户操作顺序一致。
        if (!engineCan && history && stack?.length) {
          const layout = stack.pop();
          if (layout) {
            applyLayout(commands, layout);
            (redo ? history.undo : history.redo).push(layout);
            status(redo ? "已重做版面修改" : "已撤销版面修改（纸张/页边距/分栏）");
            break;
          }
        }
        // 先确保画布有焦点/游标，再走引擎的历史栈（与 Ctrl+Z 行为一致）。
        commands.focus?.();
        commands[command]?.();
        break;
      }
      case "executePainter": {
        // 引擎的 executePainter 读 payload.isDblclick；无参会直接抛错（回归检查发现的真 bug）。
        commands.executePainter?.({ isDblclick: false });
        break;
      }
      case "executeSeparator": {
        commands.executeSeparator?.();
        break;
      }
      case "executePageBreak": {
        commands.executePageBreak?.();
        break;
      }
      default: {
        const fn = commands[command];
        if (typeof fn !== "function") {
          // 引擎没有这条命令时**必须说出来**：静默无反应正是"点了一堆按钮都没用"的来源。
          status(`该功能当前不可用：${command}`);
          break;
        }
        fn.apply(editor.command, args ?? []);
      }
    }
  } catch (error) {
    status(`${command} 执行失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 选中一处命中。
 *
 * 引擎 `getKeywordRangeList` 给的范围**不能直接用**（实测，选区是左闭右开）：
 *   - "压测"（两字，元素下标 10/11）→ 返回 {11,12}，直接用只会选中"测"；
 *   - "段"（一字，下标 4）        → 返回 {5,5}，直接用是空选区。
 * 两种长度都只差**起点减 1**：{11,12}→[10,12)="压测" ✓，{5,5}→[4,5)="段" ✓。
 * 起点差 1 是因为引擎内部元素表比 `setRange` 的下标多一个前导零宽元素。
 */
function selectMatch(commands: Record<string, unknown>, range: Record<string, unknown>): void {
  const start = Number(range.startIndex ?? -1);
  const end = Number(range.endIndex ?? -1);
  if (start < 0 || end < 0) return;
  const replaceRange = commands.executeReplaceRange as
    | ((payload: Record<string, unknown>) => void)
    | undefined;
  replaceRange?.({ ...range, startIndex: Math.max(0, start - 1), endIndex: end });
}

/** 取关键词在文档里的全部命中范围（引擎自带匹配器，表格命中带行列坐标）。 */
function getKeywordRanges(
  editor: { command: Record<string, unknown> },
  keyword: string,
): Array<Record<string, unknown>> | null {
  const getList = editor.command.getKeywordRangeList as
    | ((value: string) => Array<Record<string, unknown>>)
    | undefined;
  try {
    return getList?.(keyword) ?? null;
  } catch {
    return null;
  }
}

/** 把当前命中处选中（引擎的 search 只高亮、不移动选区，所以这里显式设选区）。 */
function highlightCurrentHit(
  editor: { command: Record<string, unknown> },
  status: (message: string) => void,
  session: FindSession,
) {
  const range = session.ranges[session.current];
  if (!range) {
    status(`未找到「${session.keyword}」`);
    return;
  }
  selectMatch(editor.command, range);
  status(`第 ${session.current + 1} / 共 ${session.ranges.length} 处「${session.keyword}」`);
}
