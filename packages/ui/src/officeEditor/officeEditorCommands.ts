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
import { getKeywordRanges, highlightCurrentHit, selectMatch } from "./engineFindReplace.js";
import { insertImageWithNaturalSize } from "./engineImageInsert.js";
import {
  applyLayout,
  LAYOUT_COMMANDS,
  readLayout,
  type LayoutHistory,
} from "./engineLayoutHistory.js";
import type { IElement } from "./engineTypes.js";

/**
 * 功能区命令入口：把 ribbon 的语义命令映射到引擎命令。
 *
 * 单独一个文件的原因有两个：编辑位本体已经接近仓库 400 行上限；更重要的是这些映射**全是实测出来的
 * 参数形态与坑**（纸张收像素、控件要整套 valueSets、连页是 "continuity"、引擎没有字数统计命令…），
 * 集中在一处才好对照 engineCommands.ts 的注释。
 */
export interface CommandContext {
  /** 引擎实例（需要 `command`，替换要读命中范围）。 */
  editor: { command: Record<string, unknown>; draw?: unknown };
  commands: EngineCommand;
  status: (message: string) => void;
  /** 当前编辑器状态：只读/页面模式要在命令之间翻转。 */
  engineState: { mode: string; pageMode: string };
  /** 查找会话：关键词、命中范围与当前位置（跨命令保留）。 */
  findRef: { current: FindSession };
  /** 版面撤销栈（纸张/页边距/方向/分栏）。 */
  layoutRef?: { current: LayoutHistory };
  /** 引擎自己还能不能撤销/重做（由编辑位从 rangeStyleChange 回填；决定"该撤文本还是撤版面"）。 */
  canUndoEngine?: () => boolean;
  canRedoEngine?: () => boolean;
  /** 审阅（Word 的接受/拒绝）：由编辑位实现（要在字节层处理并重新导入）。 */
  review?: {
    acceptCurrent: () => void;
    acceptAll: () => void;
    rejectCurrent: () => void;
    rejectAll: () => void;
    prev: () => void;
    next: () => void;
    count: () => { total: number; current: number };
  };
}

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
        const value = String(args?.[0] ?? "");
        if (!value) break;
        // 官方 demo 从 <img> 载入宽高。这里也按图片**真实尺寸**插入，并夹到版心宽度以内
        // （固定 320×240 会让竖图和照片变形/糊成一块——真机反馈"插入照片"要能选本机图片、看着正常）。
        void insertImageWithNaturalSize(commands, status, value);
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
      case "resolveAcceptCurrent":
      case "resolveAcceptAll":
      case "resolveRejectCurrent":
      case "resolveRejectAll":
      case "reviewPrev":
      case "reviewNext": {
        const review = context.review;
        if (!review) {
          status("审阅功能未接入");
          break;
        }
        const handlers: Record<string, () => void> = {
          resolveAcceptCurrent: review.acceptCurrent,
          resolveAcceptAll: review.acceptAll,
          resolveRejectCurrent: review.rejectCurrent,
          resolveRejectAll: review.rejectAll,
          reviewPrev: review.prev,
          reviewNext: review.next,
        };
        handlers[command]?.();
        break;
      }
      case "commentPrev":
      case "commentNext": {
        status("批注导航：正文里的 [n] 标记对应批注，列表与气泡在做（当前可用「批注 N 处」提示）");
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
