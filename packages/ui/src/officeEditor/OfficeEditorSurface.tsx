/**
 * 编辑区的**纸面**：滚动容器 + 纸张（宽度＝纸张宽×缩放、`mx-auto` 居中）+ 右侧批注框栏。
 *
 * 抽出来的原因：编辑位本体要守 400 行上限；而这块是纯"排版"（纸张居中、批注框贴边、滚动归属），
 * 与命令调度/审阅逻辑无关，单独放更好读。
 */
import type { RefObject } from "react";
import { layoutBalloons } from "./commentBalloons.js";
import type { DocumentComment } from "./docxRevisions.js";
import { OfficeCommentBalloons } from "./OfficeCommentBalloons.js";
import type { CommentAnchor } from "./useCommentGroups.js";

/** 批注框那一栏的宽度（Word 的批注框约 200~260px）。 */
export const BALLOON_COLUMN_WIDTH = 240;

export function OfficeEditorSurface({
  hostRef,
  scrollRef,
  hidden,
  pageWidth,
  comments,
  anchors,
  activeComment,
  onPickComment,
  onDeleteComment,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  hidden?: boolean;
  pageWidth: number;
  comments: DocumentComment[];
  anchors: Map<string, CommentAnchor>;
  activeComment: number;
  onPickComment: (index: number) => void;
  onDeleteComment: (index: number) => void;
}) {
  // 有锚点的批注走右侧批注框；没有锚点的由编辑位的列表兜底（Word 里这类在审阅窗格）
  const positioned = comments.filter((comment) => anchors.get(comment.id)?.anchor);
  return (
    // 容器必须可滚动：canvas-editor 把所有页面画在同一张 canvas 上，滚动由外层承担。
    // 之前沿用 SuperDoc 版的 overflow-hidden，导致"无法滚动"——真机反馈。
    <div
      hidden={hidden}
      id="office-editor-scroll"
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto bg-surface"
    >
      {/* 纸张 + 右侧批注栏作为一个整体居中（拉宽/变窄面板时纸张跟着居中） */}
      <div className="relative mx-auto" style={{ width: pageWidth + BALLOON_COLUMN_WIDTH + 12 }}>
        <div ref={hostRef} id="office-editor-host" style={{ width: pageWidth }} />
        <OfficeCommentBalloons
          comments={positioned}
          anchors={anchors}
          positions={layoutBalloons(
            positioned.map((comment) => ({
              id: comment.id,
              anchorTop: anchors.get(comment.id)?.anchor?.y ?? null,
              height: anchors.get(comment.id)?.height ?? 52,
            })),
          )}
          pageWidth={pageWidth}
          columnWidth={BALLOON_COLUMN_WIDTH}
          activeIndex={activeComment}
          onPick={onPickComment}
          onDelete={onDeleteComment}
        />
      </div>
    </div>
  );
}
