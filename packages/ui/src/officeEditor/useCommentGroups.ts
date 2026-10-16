/**
 * 批注的引擎侧能力：**用官方 demo 的那套 API**（`executeSetGroup` / `executeLocationGroup` /
 * `executeDeleteGroup`），不自己发明正文标记。
 *
 * demo 的做法是"选中一段文字 → 建组 → 宿主记一条卡片（作者/内容/时间）→ 需要时定位/删除"；
 * 我们这里把"文件里的批注"接到同一套 API 上：导入后按锚点文字（`w:commentRangeStart/End` 之间）建组，
 * 卡片列表由 `OfficeCommentList` 渲染，点卡片 → 定位，删除 → 删组。
 */
import { useCallback, useRef } from "react";
import type { DocumentComment } from "./docxRevisions.js";

export interface CommentGroupsHandle {
  command: Record<string, unknown>;
}

export function useCommentGroups() {
  const groupsRef = useRef<Map<string, string>>(new Map());

  /** 导入后：把每条批注的锚点文字建成引擎 group。 */
  const groupComments = useCallback((editor: CommentGroupsHandle, comments: DocumentComment[]) => {
    const commands = editor.command;
    const groups = new Map<string, string>();
    for (const comment of comments) {
      if (!comment.anchorText.trim()) continue;
      const ranges = (
        commands.getKeywordRangeList as
          | ((value: string) => Array<{ startIndex: number; endIndex: number }>)
          | undefined
      )?.(comment.anchorText);
      const range = ranges?.[0];
      if (!range) continue;
      (commands.executeReplaceRange as ((payload: Record<string, unknown>) => void) | undefined)?.({
        ...range,
        startIndex: Math.max(0, range.startIndex - 1),
        endIndex: range.endIndex,
      });
      const groupId = (commands.executeSetGroup as (() => string | null) | undefined)?.();
      if (groupId) groups.set(comment.id, groupId);
    }
    groupsRef.current = groups;
  }, []);

  /** 定位到某条批注（`executeLocationGroup`，demo 同款）。 */
  const locateComment = useCallback((editor: CommentGroupsHandle, comment: DocumentComment) => {
    const groupId = groupsRef.current.get(comment.id);
    const locationGroup = editor.command.executeLocationGroup as ((id: string) => void) | undefined;
    if (groupId) locationGroup?.(groupId);
    return groupId !== undefined;
  }, []);

  /** 删除某条批注（`executeDeleteGroup`，demo 同款）。 */
  const forgetComment = useCallback((editor: CommentGroupsHandle, comment: DocumentComment) => {
    const groupId = groupsRef.current.get(comment.id);
    const deleteGroup = editor.command.executeDeleteGroup as ((id: string) => void) | undefined;
    if (groupId) deleteGroup?.(groupId);
    groupsRef.current.delete(comment.id);
  }, []);

  return { groupComments, locateComment, forgetComment };
}
