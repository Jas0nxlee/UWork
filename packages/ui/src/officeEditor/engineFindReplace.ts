/**
 * 查找/替换的引擎适配。
 *
 * 两个实测坑（都写进注释，免得再踩）：
 *   - `getKeywordRangeList` 返回的范围**不能直接用于选区**：选区左闭右开，而它把起点多算了 1
 *     （"压测"返回 {11,12}，直接用只选中"测"；"段"返回 {5,5}，直接用是空选区）。两种长度都只差起点减 1；
 *   - 引擎的 search 只高亮、**不移动选区**，所以"上一个/下一个"要我们显式设选区。
 */
import type { FindSession } from "./engineTypes.js";

/**
 * 选中一处命中。
 *
 * 引擎 `getKeywordRangeList` 给的范围**不能直接用**（实测，选区是左闭右开）：
 *   - "压测"（两字，元素下标 10/11）→ 返回 {11,12}，直接用只会选中"测"；
 *   - "段"（一字，下标 4）        → 返回 {5,5}，直接用是空选区。
 * 两种长度都只差**起点减 1**：{11,12}→[10,12)="压测" ✓，{5,5}→[4,5)="段" ✓。
 * 起点差 1 是因为引擎内部元素表比 `setRange` 的下标多一个前导零宽元素。
 */
export function selectMatch(
  commands: Record<string, unknown>,
  range: Record<string, unknown>,
): void {
  const start = Number(range.startIndex ?? -1);
  const end = Number(range.endIndex ?? -1);
  if (start < 0 || end < 0) return;
  const replaceRange = commands.executeReplaceRange as
    | ((payload: Record<string, unknown>) => void)
    | undefined;
  replaceRange?.({ ...range, startIndex: Math.max(0, start - 1), endIndex: end });
}

/** 取关键词在文档里的全部命中范围（引擎自带匹配器，表格命中带行列坐标）。 */
export function getKeywordRanges(
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
export function highlightCurrentHit(
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
