/**
 * 审阅导航（Word 的"上一条/下一条"）：把视图移到某条修订/批注上。
 *
 * 定位手段用**引擎自己的匹配器**（`getKeywordRangeList`），不自己算元素下标：
 * 修订按"同文字的文档顺序第 k 次出现"选中（两个列表都是文档顺序，所以对得上）；
 * 批注则选中锚点文字——只调 `executeLocationGroup` 看不出"跳过去了"（真机反馈"不管用"）。
 */
import type { RevisionItem } from "./docxReview.js";
import type { DocumentComment } from "./docxRevisions.js";

interface Commands {
  command: Record<string, unknown>;
}

function selectText(editor: Commands, text: string, occurrence = 0): boolean {
  const keyword = text.trim();
  if (!keyword) return false;
  const ranges = (
    editor.command.getKeywordRangeList as
      | ((value: string) => Array<{ startIndex: number; endIndex: number }>)
      | undefined
  )?.(keyword);
  const range = ranges?.[occurrence] ?? ranges?.[0];
  if (!range) return false;
  (
    editor.command.executeReplaceRange as ((payload: Record<string, unknown>) => void) | undefined
  )?.({
    ...range,
    startIndex: Math.max(0, range.startIndex - 1),
    endIndex: range.endIndex,
  });
  (editor.command.focus as (() => void) | undefined)?.();
  return true;
}

/** 跳到第 n 条修订；返回是否找到了对应文字（找不到时调用方给一句如实的提示）。 */
export function gotoRevision(editor: Commands, revisions: RevisionItem[], index: number): boolean {
  const revision = revisions[index];
  if (!revision) return false;
  const keyword = revision.text.trim();
  const occurrence = revisions
    .slice(0, index)
    .filter((item) => item.text.trim() === keyword && item.kind === revision.kind).length;
  return selectText(editor, keyword, occurrence);
}

/** 跳到第 n 条批注（选中它的锚点文字）。 */
export function gotoCommentAnchor(editor: Commands, comment: DocumentComment): boolean {
  return selectText(editor, comment.anchorText);
}

/** 跳到第 n 条修订并把结果说清楚（供功能区的"上一条/下一条"用）。 */
export function gotoRevisionWithStatus(input: {
  editorRef: { current: Commands | null };
  revisions: RevisionItem[];
  index: number;
  setCurrentRevision: (index: number) => void;
  setStatus: (message: string) => void;
  scrollContainer?: HTMLElement | null;
  scale?: number;
}): void {
  const editor = input.editorRef.current;
  const revision = input.revisions[input.index];
  if (!editor || !revision) {
    input.setStatus(input.revisions.length ? "没有下一条修订了" : "这份文档没有修订");
    return;
  }
  input.setCurrentRevision(input.index);
  const kind = revision.kind === "insert" ? "插入" : "删除";
  const moved = gotoRevision(editor, input.revisions, input.index);
  if (moved && input.scrollContainer) {
    scrollSelectionIntoView(editor, input.scrollContainer, input.scale ?? 1);
  }
  if (moved) {
    input.setStatus(
      `第 ${input.index + 1}/${input.revisions.length} 条修订 · ${kind}「${revision.text.slice(0, 20)}」`,
    );
  } else {
    input.setStatus(`第 ${input.index + 1} 条修订（${kind}）：正文里没找到对应文字`);
  }
}

/**
 * 把当前选区**滚进可见区**（Word 的导航会跟着滚）。
 *
 * 为什么需要：`executeSetRange` 只设选区，引擎不会自动滚——真机反馈"上下箭头不跟随"就是
 * "定位到了但视图没过去"。目标矩形取 `getRangeContext().rangeRects[0]`（文档坐标，× 缩放即屏幕位置），
 * 只做最小滚动：已经在可见区里就不动。
 */
export function scrollSelectionIntoView(
  editor: Commands & { getScrollContainer?: () => HTMLElement | null },
  scrollContainer: HTMLElement | null,
  scale: number,
  options: { padding?: number } = {},
): boolean {
  if (!scrollContainer) return false;
  const context = (
    editor.command.getRangeContext as
      | (() => {
          rangeRects?: Array<{ x: number; y: number; width: number; height: number }>;
        } | null)
      | undefined
  )?.();
  const rect = context?.rangeRects?.[0];
  if (!rect) return false;
  const next = scrollTopForRect({
    rect,
    scale,
    scrollTop: scrollContainer.scrollTop,
    viewportHeight: scrollContainer.clientHeight,
    ...(options.padding === undefined ? {} : { padding: options.padding }),
  });
  if (next === null) return false;
  scrollContainer.scrollTop = next;
  return true;
}

/**
 * 目标矩形要不要滚、滚到哪里（纯函数，便于断言）。
 * 已经在可见区（留 padding）里 → 返回 null（不动）；否则返回"把目标顶部对齐到 padding 处"的位置。
 */
export function scrollTopForRect(input: {
  rect: { y: number; height: number };
  scale: number;
  scrollTop: number;
  viewportHeight: number;
  padding?: number;
}): number | null {
  const padding = input.padding ?? 24;
  const targetTop = input.rect.y * input.scale;
  const targetBottom = (input.rect.y + input.rect.height) * input.scale;
  const viewTop = input.scrollTop;
  const viewBottom = viewTop + input.viewportHeight;
  if (targetTop >= viewTop + padding && targetBottom <= viewBottom - padding) return null;
  return Math.max(0, targetTop - padding);
}
