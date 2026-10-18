import { memo } from "react";
import type { IImService } from "@zcode/services";
import type { ImMessage } from "@zcode/shared";
import { PinIcon, SmilePlusIcon } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { formatClockTime, initialsOf, avatarTone, type ImTimelineRow } from "./imPresentation.js";
import { ImAttachmentView } from "./ImAttachmentView.js";
import {
  IM_MESSAGE_BODY,
  IM_MESSAGE_GROUP_GAP,
  IM_MESSAGE_NAME,
  IM_MESSAGE_ROW,
  IM_MESSAGE_TIGHT_GAP,
  IM_MESSAGE_TIME,
  IM_TOOLBAR,
  IM_TOOLBAR_BUTTON,
  IM_TOOLBAR_BUTTON_DANGER,
} from "./imChrome.js";
import { splitMentions } from "./imMentions.js";
import { splitHighlight } from "./imSearch.js";

/** 常用表情：工具条上的"表情"只给一屏能放下的集合，不做完整 emoji 面板。 */
const QUICK_REACTIONS = ["👍", "🎉", "✅", "👀", "🙏", "😅"];

/**
 * 一条消息长什么样 + 它自己的一组动作。
 *
 * 动作有两个入口：**悬停工具条**（表情/编辑/回复/转发/复制/撤回）与**右键菜单**（同样的集合，
 * 但撤回是点击即撤——菜单点完就关，做不了两步确认）。两者共用同一批回调，行为差异只在撤回那一步。
 */
export const ImMessageRow = memo(function ImMessageRow({
  row,
  t,
  service,
  selfUserId,
  selfName,
  senderNameOf,
  query,
  activeMessageId,
  confirmingId,
  bookmarked,
  onEdit,
  onReply,
  onForward,
  onWithdraw,
  onWithdrawNow,
  onJumpToMessage,
  onToggleReaction,
  onTogglePin,
  onToggleBookmark,
}: {
  row: Extract<ImTimelineRow, { kind: "message" }>;
  t: (id: string, values?: Record<string, string | number>) => string;
  service: IImService | null;
  selfUserId: string | null;
  selfName: string | null;
  senderNameOf: (id: string) => string | undefined;
  query: string;
  activeMessageId: string | null;
  confirmingId: string | null;
  bookmarked: boolean;
  onEdit: (message: ImMessage) => void;
  onReply: (message: ImMessage) => void;
  onForward: (message: ImMessage) => void;
  onWithdraw: (message: ImMessage) => void;
  onWithdrawNow: (message: ImMessage) => void;
  onJumpToMessage: (messageId: string) => void;
  onToggleReaction: (message: ImMessage, emoji: string, mine: boolean) => void;
  onTogglePin: (message: ImMessage, pinned: boolean) => void;
  onToggleBookmark: (message: ImMessage, bookmarked: boolean) => void;
}) {
  const withdrawn = row.message.deletedAt !== null;
  const rawName = senderNameOf(row.message.senderId) ?? row.message.senderId;
  const senderLabel = row.mine ? `${rawName}（${t("im.you")}）` : rawName;
  const active = row.message.id === activeMessageId;
  const replyTo = row.message.replyTo;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        data-im-message-id={row.message.id}
        className={cn(
          IM_MESSAGE_ROW,
          row.gap === "normal" ? IM_MESSAGE_GROUP_GAP : IM_MESSAGE_TIGHT_GAP,
          active && "bg-surface ring-1 ring-border-hover",
        )}
      >
        <span className="w-9 shrink-0">
          {row.showHeader ? (
            <span
              className={cn(
                "flex size-9 items-center justify-center rounded-full text-ui-2xs font-medium",
                avatarTone(row.message.senderId),
              )}
            >
              {initialsOf(rawName)}
            </span>
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          {row.showHeader ? (
            <div className="flex items-baseline gap-2">
              <span className={IM_MESSAGE_NAME}>{senderLabel}</span>
              <span className={IM_MESSAGE_TIME}>{formatClockTime(row.message.createdAt)}</span>
              {row.message.editedAt != null && !withdrawn ? (
                <span data-testid="im-message-edited" className={IM_MESSAGE_TIME}>
                  {t("im.edited")}
                </span>
              ) : null}
              {row.message.pinnedAt != null ? (
                <PinIcon
                  data-testid="im-message-pinned"
                  className="size-3 shrink-0 text-foreground-subtle"
                />
              ) : null}
            </div>
          ) : null}

          {replyTo ? (
            <button
              type="button"
              data-im-reply-target={replyTo.messageId}
              className="mt-1 flex max-w-full items-start gap-1.5 border-l-2 border-border pl-2 text-left text-ui-2xs text-foreground-subtle hover:text-foreground"
              onClick={() => onJumpToMessage(replyTo.messageId)}
            >
              <span className="shrink-0 font-medium text-foreground/70">
                {senderNameOf(replyTo.senderId) ?? replyTo.senderId}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {replyTo.deleted ? t("im.withdrawn") : replyTo.body}
              </span>
            </button>
          ) : null}

          {withdrawn ? (
            <p className="mt-0.5 text-ui-xs text-foreground-subtle italic">{t("im.withdrawn")}</p>
          ) : row.message.kind === "attachment" ? (
            // 附件消息的 body 是载荷 JSON：正文位渲染成附件（图片/文件卡片），
            // 解析不了也让 ImAttachmentView 自己给提示，不要把 JSON 当正文甩给用户。
            <ImAttachmentView service={service} body={row.message.body} />
          ) : (
            <p className={IM_MESSAGE_BODY}>{renderBody(row.message, query, selfName)}</p>
          )}

          {(row.message.reactions?.length ?? 0) > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {(row.message.reactions ?? []).map((reaction) => {
                const mine = selfUserId !== null && reaction.userIds.includes(selfUserId);
                return (
                  <button
                    key={reaction.emoji}
                    type="button"
                    data-testid="im-reaction-chip"
                    data-reaction-mine={mine ? "true" : "false"}
                    className={cn(
                      "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-ui-2xs transition-colors",
                      mine
                        ? "border-primary/50 bg-primary/10 text-foreground"
                        : "border-border bg-surface text-foreground-subtle hover:border-border-hover",
                    )}
                    onClick={() => onToggleReaction(row.message, reaction.emoji, mine)}
                  >
                    <span>{reaction.emoji}</span>
                    <span className="tabular-nums">{reaction.count}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* 悬停工具条：贴在消息行右上角（Slack/飞书都是"指到哪条出哪条"）。 */}
          {!withdrawn ? (
            <div
              data-im-message-toolbar="true"
              className={cn(
                IM_TOOLBAR,
                confirmingId === row.message.id
                  ? "pointer-events-auto opacity-100"
                  : "opacity-0 group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100",
              )}
            >
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("im.react")}
                    className={cn(IM_TOOLBAR_BUTTON, "flex items-center px-1.5")}
                  >
                    <SmilePlusIcon className="size-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" side="top" className="w-auto p-1.5">
                  <div className="flex items-center gap-1">
                    {QUICK_REACTIONS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        data-testid="im-reaction-pick"
                        className="rounded-md px-1.5 py-1 text-base transition-colors hover:bg-surface-hover"
                        onClick={() => {
                          const mine =
                            selfUserId !== null &&
                            row.message.reactions
                              .find((item) => item.emoji === emoji)
                              ?.userIds?.includes(selfUserId) === true;
                          onToggleReaction(row.message, emoji, mine);
                        }}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              {row.mine && !withdrawn && row.message.kind === "text" ? (
                <ToolbarButton label={t("im.edit")} onClick={() => onEdit(row.message)} />
              ) : null}
              <ToolbarButton label={t("im.reply")} onClick={() => onReply(row.message)} />
              <ToolbarButton label={t("im.forward")} onClick={() => onForward(row.message)} />
              <ToolbarButton
                label={t("im.copy")}
                onClick={() => void copyMessage(row.message.body)}
              />
              {row.mine ? (
                <ToolbarButton
                  label={
                    confirmingId === row.message.id ? t("im.withdrawConfirm") : t("im.withdraw")
                  }
                  danger={confirmingId === row.message.id}
                  onClick={() => onWithdraw(row.message)}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onReply(row.message)}>{t("im.reply")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => onForward(row.message)}>{t("im.forward")}</ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void copyMessage(row.message.body)}
          disabled={withdrawn || !row.message.body}
        >
          {t("im.copy")}
        </ContextMenuItem>
        {replyTo ? (
          <ContextMenuItem onSelect={() => onJumpToMessage(replyTo.messageId)}>
            {t("im.jumpToQuoted")}
          </ContextMenuItem>
        ) : null}
        {!withdrawn ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => onTogglePin(row.message, row.message.pinnedAt === null)}
            >
              {row.message.pinnedAt === null ? t("im.pinMessage") : t("im.unpinMessage")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onToggleBookmark(row.message, !bookmarked)}>
              {bookmarked ? t("im.unbookmark") : t("im.bookmark")}
            </ContextMenuItem>
          </>
        ) : null}
        {row.mine && !withdrawn ? (
          <>
            <ContextMenuSeparator />
            {row.message.kind === "text" ? (
              <ContextMenuItem onSelect={() => onEdit(row.message)}>{t("im.edit")}</ContextMenuItem>
            ) : null}
            <ContextMenuItem variant="destructive" onSelect={() => onWithdrawNow(row.message)}>
              {t("im.withdraw")}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * 正文渲染：**先切 @提及，再在非提及片段里切检索高亮**。
 * 顺序不能反：反了的话 `@部署` 这类内容会被检索高亮切成两截，提及样式就断了。
 */
function renderBody(message: ImMessage, query: string, selfName: string | null): React.ReactNode {
  return splitMentions(message.body, selfName).flatMap((segment, segmentIndex) => {
    if (segment.mention) {
      return (
        <span
          key={`m-${segmentIndex}`}
          className={cn(
            "rounded-sm px-0.5",
            segment.mine
              ? "bg-primary/25 font-medium text-foreground"
              : "bg-surface text-foreground",
          )}
        >
          {segment.text}
        </span>
      );
    }
    if (!query) return <span key={`t-${segmentIndex}`}>{segment.text}</span>;
    return splitHighlight(segment.text, query).map((part, partIndex) =>
      part.match ? (
        <mark
          key={`h-${segmentIndex}-${partIndex}`}
          className="rounded-sm bg-primary/30 text-foreground"
        >
          {part.text}
        </mark>
      ) : (
        <span key={`t-${segmentIndex}-${partIndex}`}>{part.text}</span>
      ),
    );
  });
}

/** 复制正文。剪贴板不可用（无权限/非安全上下文）时静默失败——复制不是主路径，不值得弹错误。 */
async function copyMessage(body: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(body);
  } catch {
    // 忽略
  }
}

function ToolbarButton({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(IM_TOOLBAR_BUTTON, danger && IM_TOOLBAR_BUTTON_DANGER)}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
