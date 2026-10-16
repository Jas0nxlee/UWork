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
}): void {
  const editor = input.editorRef.current;
  const revision = input.revisions[input.index];
  if (!editor || !revision) {
    input.setStatus(input.revisions.length ? "没有下一条修订了" : "这份文档没有修订");
    return;
  }
  input.setCurrentRevision(input.index);
  const kind = revision.kind === "insert" ? "插入" : "删除";
  if (gotoRevision(editor, input.revisions, input.index)) {
    input.setStatus(
      `第 ${input.index + 1}/${input.revisions.length} 条修订 · ${kind}「${revision.text.slice(0, 20)}」`,
    );
  } else {
    input.setStatus(`第 ${input.index + 1} 条修订（${kind}）：正文里没找到对应文字`);
  }
}
