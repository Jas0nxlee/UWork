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
  onDelete,
}: {
  comments: DocumentComment[];
  current: number;
  onPick: (index: number) => void;
  onDelete?: (index: number) => void;
}) {
  if (comments.length === 0) return null;
  return (
    <div className="border-b border-border bg-surface px-2 py-1.5 text-xs">
      <div className="pb-1 text-foreground-subtle">
        批注 {comments.length} 条（点一条定位到正文；卡片结构照官方 demo：作者 · 时间 / 锚点 /
        内容）
      </div>
      <div className="flex max-h-28 flex-col gap-1 overflow-auto">
        {comments.map((comment, index) => (
          <div
            key={comment.id || comment.index}
            className={`flex items-start gap-2 rounded border px-2 py-1 ${
              index === current ? "border-sky-500" : "border-border"
            }`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => onPick(index)}
              title={comment.anchorText ? `锚点：${comment.anchorText}` : "（没有锚点范围）"}
            >
              <span className="block truncate text-foreground-subtle">
                {comment.author || "（未知作者）"}
                {comment.date ? ` · ${comment.date.slice(0, 16).replace("T", " ")}` : ""}
              </span>
              <span className="block truncate">{comment.text || "（无内容）"}</span>
            </button>
            {onDelete ? (
              <button
                type="button"
                className="shrink-0 rounded border border-border px-1.5 py-0.5 text-foreground-subtle hover:border-rose-400 hover:text-rose-300"
                onClick={() => onDelete(index)}
                title="删除这条批注（正文保留，保存时写回文件）"
              >
                删除
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
