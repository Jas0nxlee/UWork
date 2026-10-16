/**
 * 批注列表（Word 的审阅窗格）：一条一行，点一下就定位到正文里的 `[n]` 标记。
 *
 * 单独成文件的原因：编辑位要守 400 行上限；批注列表后续还要长（回复、解决、删除），
 * 单放一处更好长。
 */
import type { DocumentComment } from "./docxRevisions.js";

export function OfficeCommentList({
  comments,
  current,
  onPick,
}: {
  comments: DocumentComment[];
  current: number;
  onPick: (index: number) => void;
}) {
  if (comments.length === 0) return null;
  return (
    <div className="border-b border-border bg-surface px-2 py-1.5 text-xs">
      <div className="pb-1 text-foreground-subtle">
        批注 {comments.length} 条（点一条定位到正文里的标记）
      </div>
      <div className="flex max-h-24 flex-col gap-1 overflow-auto">
        {comments.map((comment, index) => (
          <button
            key={comment.id || comment.index}
            type="button"
            className={`truncate rounded border px-2 py-1 text-left ${
              index === current
                ? "border-sky-500 text-sky-200"
                : "border-border text-foreground hover:bg-background"
            }`}
            onClick={() => onPick(index)}
          >
            [{comment.index}] {comment.author ? `${comment.author}：` : ""}
            {comment.text || "（无内容）"}
          </button>
        ))}
      </div>
    </div>
  );
}
