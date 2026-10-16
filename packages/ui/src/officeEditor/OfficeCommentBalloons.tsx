/**
 * 批注气泡（Word 的"批注框"）：贴在纸张**右侧页边距**，按锚点垂直位置对齐，细线连到被批注的文字。
 *
 * 做法沿用官方 demo 的坐标系：`command.getGroupRectList(groupId)` 拿到锚点矩形（文档坐标，含跨页偏移），
 * 乘上缩放后就是卡片该在的位置；重叠时由 layoutBalloons 往下让。渲染层只负责画。
 */
import type { BalloonPosition } from "./commentBalloons.js";
import type { DocumentComment } from "./docxRevisions.js";

export interface CommentAnchorRect {
  id: string;
  /** 锚点矩形（文档坐标，已乘缩放；没有锚点时为 null）。 */
  anchor: { x: number; y: number; width: number; height: number } | null;
  /** 卡片高度（渲染前估算，用于占位与让位）。 */
  height: number;
}

export function OfficeCommentBalloons({
  comments,
  anchors,
  positions,
  pageWidth,
  columnWidth,
  activeIndex,
  onPick,
  onDelete,
}: {
  comments: DocumentComment[];
  anchors: Map<string, CommentAnchorRect>;
  positions: BalloonPosition[];
  pageWidth: number;
  columnWidth: number;
  activeIndex: number;
  onPick: (index: number) => void;
  onDelete: (index: number) => void;
}) {
  if (comments.length === 0) return null;
  const positionOf = new Map(positions.map((entry) => [entry.id, entry]));
  return (
    <div
      data-office-comment-balloons
      className="pointer-events-none absolute top-0"
      style={{ left: pageWidth + 12, width: columnWidth }}
    >
      {/* 引线：从正文锚点右侧连到卡片（Word 也是一条细线） */}
      <svg className="absolute left-0 top-0 h-full w-full overflow-visible" aria-hidden>
        {comments.map((comment, index) => {
          const anchor = anchors.get(comment.id)?.anchor;
          const position = positionOf.get(comment.id);
          if (!anchor || !position) return null;
          const fromX = anchor.x + anchor.width;
          const fromY = anchor.y + anchor.height / 2;
          const toX = -12;
          const toY = position.top + 14;
          return (
            <path
              key={comment.id}
              d={`M ${fromX} ${fromY} L ${toX + 6} ${fromY} L ${toX} ${toY}`}
              className={index === activeIndex ? "stroke-sky-400" : "stroke-stone-400"}
              fill="none"
              strokeWidth={1}
            />
          );
        })}
      </svg>
      {comments.map((comment, index) => {
        const position = positionOf.get(comment.id);
        const anchor = anchors.get(comment.id)?.anchor ?? null;
        return (
          <div
            key={comment.id || comment.index}
            data-office-comment-balloon={comment.id}
            className={`pointer-events-auto absolute rounded border px-2 py-1 text-xs shadow-sm ${
              index === activeIndex
                ? "border-sky-500 bg-sky-500/10"
                : "border-stone-400/60 bg-stone-100/95 text-stone-800"
            }`}
            style={{
              top: position?.top ?? 0,
              width: columnWidth,
              minHeight: anchor ? undefined : 0,
            }}
          >
            <div className="flex items-start justify-between gap-1">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onPick(index)}
                title={anchor ? "定位到被批注的文字" : "这条批注没有锚点范围"}
              >
                <span className="block truncate font-medium">
                  {comment.author || "（未知作者）"}
                  {comment.date ? ` · ${comment.date.slice(0, 16).replace("T", " ")}` : ""}
                </span>
                <span className="block whitespace-pre-wrap break-words">
                  {comment.text || "（无内容）"}
                </span>
              </button>
              <button
                type="button"
                className="shrink-0 rounded border border-stone-400/60 px-1 text-stone-600 hover:border-rose-400 hover:text-rose-600"
                onClick={() => onDelete(index)}
                title="删除这条批注（正文保留，保存时写回文件）"
              >
                删除
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
