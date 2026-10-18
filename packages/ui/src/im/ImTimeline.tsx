import { memo } from "react";
import type { IImService } from "@zcode/services";
import { parseImAttachmentBody, type ImMessage } from "@zcode/shared";
import { SmilePlusIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { avatarTone, formatClockTime, initialsOf, type ImTimelineRow } from "./imPresentation.js";
import type { ImOutboxItem } from "./imOutbox.js";
import { ImAttachmentView } from "./ImAttachmentView.js";
import { splitHighlight } from "./imSearch.js";
import {
  IM_DIVIDER_LABEL,
  IM_DIVIDER_LINE,
  IM_DIVIDER_ROW,
  IM_MESSAGE_BODY,
  IM_MESSAGE_GROUP_GAP,
  IM_MESSAGE_NAME,
  IM_MESSAGE_ROW,
  IM_MESSAGE_TIGHT_GAP,
  IM_MESSAGE_TIME,
  IM_SYSTEM_PILL,
  IM_TOOLBAR,
  IM_TOOLBAR_BUTTON,
  IM_TOOLBAR_BUTTON_DANGER,
} from "./imChrome.js";
import { describeSystemMessage } from "./imSystemMessage.js";

/**
 * 时间线的一段渲染：日期/未读分隔、消息行（含引用块与悬停工具条）、系统消息、本地乐观消息。
 *
 * 工具条按成熟 IM 的动作集给：回复 / 转发 / 复制 / 撤回（撤回只在自己的消息上）。
 * 这一层不做网络也不做导航——动作由面板实现，它只负责"把按钮画在正确的位置"。
 */
/** 常用表情：设计稿里工具条上的"表情"只给一屏能放下的集合，不做完整 emoji 面板。 */
const QUICK_REACTIONS = ["👍", "🎉", "✅", "👀", "🙏", "😅"];

export const ImTimeline = memo(function ImTimeline({
  service,
  selfUserId,
  rows,
  outbox,
  selfLabel,
  senderNameOf,
  query,
  activeMessageId,
  confirmingId,
  onWithdraw,
  onReply,
  onForward,
  onJumpToMessage,
  onRetryOutbox,
  onDiscardOutbox,
  onToggleReaction,
}: {
  rows: ImTimelineRow[];
  outbox: ImOutboxItem[];
  selfLabel: string;
  senderNameOf: (id: string) => string | undefined;
  query: string;
  activeMessageId: string | null;
  confirmingId: string | null;
  onWithdraw: (message: ImMessage) => void;
  onReply: (message: ImMessage) => void;
  onForward: (message: ImMessage) => void;
  onJumpToMessage: (messageId: string) => void;
  onRetryOutbox: (clientMsgId: string) => void;
  onDiscardOutbox: (clientMsgId: string) => void;
  /** 附件要用它取字节（带鉴权的 fetch）；回应要用它提交。 */
  service: IImService | null;
  selfUserId: string | null;
  onToggleReaction: (message: ImMessage, emoji: string, mine: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>): string =>
    intl.formatMessage({ id }, values);

  return (
    <>
      {rows.map((row) => {
        if (row.kind === "day") {
          return (
            <div key={row.key} className={IM_DIVIDER_ROW}>
              <span className={IM_DIVIDER_LINE} />
              <span className={IM_DIVIDER_LABEL}>{row.label}</span>
              <span className={IM_DIVIDER_LINE} />
            </div>
          );
        }
        if (row.kind === "unread") {
          return (
            <div key={row.key} className={IM_DIVIDER_ROW}>
              <span className={cn(IM_DIVIDER_LINE, "bg-primary/40")} />
              <span className={cn(IM_DIVIDER_LABEL, "text-primary")}>{t("im.newMessages")}</span>
              <span className={cn(IM_DIVIDER_LINE, "bg-primary/40")} />
            </div>
          );
        }
        if (row.kind === "system") {
          return (
            <div
              key={row.key}
              data-im-message-id={row.message.id}
              data-im-system-message="true"
              className="my-2 flex justify-center"
            >
              <span className={IM_SYSTEM_PILL}>
                {describeSystemMessage(row.message.body, senderNameOf, t).text}
              </span>
            </div>
          );
        }
        const withdrawn = row.message.deletedAt !== null;
        const rawName = senderNameOf(row.message.senderId) ?? row.message.senderId;
        const senderLabel = row.mine ? `${rawName}（${t("im.you")}）` : rawName;
        const active = row.message.id === activeMessageId;
        const replyTo = row.message.replyTo;
        return (
          <div
            key={row.key}
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
                <p className="mt-0.5 text-ui-xs text-foreground-subtle italic">
                  {t("im.withdrawn")}
                </p>
              ) : row.message.kind === "attachment" ? (
                // 附件消息的 body 是载荷 JSON：正文位渲染成附件（图片/文件卡片），
                // 解析不了也让 ImAttachmentView 自己给提示，不要把 JSON 当正文甩给用户。
                <ImAttachmentView service={service} body={row.message.body} />
              ) : (
                <p className={IM_MESSAGE_BODY}>
                  {query
                    ? splitHighlight(row.message.body, query).map((segment, index) =>
                        segment.match ? (
                          <mark key={index} className="rounded-sm bg-primary/30 text-foreground">
                            {segment.text}
                          </mark>
                        ) : (
                          <span key={index}>{segment.text}</span>
                        ),
                      )
                    : row.message.body}
                </p>
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
          </div>
        );
      })}

      {/* 本地乐观消息：先画出来，状态随后由发送结果决定。 */}
      {outbox.map((item) => (
        <OutboxRow
          key={item.clientMsgId}
          item={item}
          selfLabel={selfLabel}
          onRetry={() => onRetryOutbox(item.clientMsgId)}
          onDiscard={() => onDiscardOutbox(item.clientMsgId)}
        />
      ))}
    </>
  );
});

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

function OutboxRow({
  item,
  selfLabel,
  onRetry,
  onDiscard,
}: {
  item: ImOutboxItem;
  selfLabel: string;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string): string => intl.formatMessage({ id });
  const failed = item.status === "failed";
  return (
    <div
      data-im-outbox-id={item.clientMsgId}
      data-im-outbox-status={item.status}
      className="mt-3 flex gap-3"
    >
      <span className="w-9 shrink-0">
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-ui-2xs font-medium text-muted-foreground">
          {initialsOf(selfLabel)}
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={IM_MESSAGE_NAME}>{selfLabel}</span>
          <span className={IM_MESSAGE_TIME}>{failed ? t("im.sendFailed") : t("im.sending")}</span>
        </div>
        {item.replyTo ? (
          <p className="mt-1 border-l-2 border-border pl-2 text-ui-2xs text-muted-foreground">
            {item.replyTo.body}
          </p>
        ) : null}
        <p className={cn(IM_MESSAGE_BODY, failed && "text-foreground-subtle")}>
          {parseImAttachmentBody(item.body)?.name ?? item.body}
        </p>
        {failed ? (
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-ui-2xs text-primary hover:bg-accent"
              onClick={onRetry}
            >
              {t("im.retrySend")}
            </button>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-ui-2xs text-muted-foreground hover:bg-accent"
              onClick={onDiscard}
            >
              {t("im.discardSend")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
