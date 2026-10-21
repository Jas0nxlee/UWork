import { memo } from "react";
import type { IImService } from "@zcode/services";
import type { ImMessage, ImCardDocument } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ImTimelineRow } from "./imPresentation.js";
import type { ImOutboxItem } from "./imOutbox.js";
import { ImMessageRow } from "./ImMessageRow.js";
import { ImOutboxRow } from "./ImOutboxRow.js";
import { IM_DIVIDER_LABEL, IM_DIVIDER_LINE, IM_DIVIDER_ROW, IM_SYSTEM_PILL } from "./imChrome.js";
import { describeSystemMessage } from "./imSystemMessage.js";

/**
 * 时间线：日期/未读分隔、系统消息、消息行、本地乐观消息。
 *
 * 这一层只管**排版与顺序**：一条消息长什么样在 `ImMessageRow`，动作由面板实现。
 * 拆开的理由是同一次改动里消息行涨到了两百多行（引用块 + 工具条 + 右键 + 附件 + 回应），
 * 留在时间线里会同时承担两件事。
 */
/** 没传收藏集合时的默认值（宿主可能没有收藏能力）。 */
const EMPTY_BOOKMARKS: ReadonlySet<string> = new Set();

export const ImTimeline = memo(function ImTimeline({
  service,
  selfUserId,
  rows,
  outbox,
  selfLabel,
  selfName,
  senderNameOf,
  bookmarkedIds = EMPTY_BOOKMARKS,
  query,
  activeMessageId,
  onCardAction,
  confirmingId,
  onWithdraw,
  onWithdrawNow,
  onReply,
  onForward,
  onJumpToMessage,
  onRetryOutbox,
  onDiscardOutbox,
  onToggleReaction,
  onEdit,
  onTogglePin,
  onToggleBookmark,
}: {
  rows: ImTimelineRow[];
  outbox: ImOutboxItem[];
  selfLabel: string;
  /** 我自己的名字：@高亮要区分"提到我"与"提到别人"。 */
  selfName: string | null;
  senderNameOf: (id: string) => string | undefined;
  /** 我收藏过的消息 id：右键菜单显示"收藏/取消收藏"。 */
  bookmarkedIds?: ReadonlySet<string>;
  query: string;
  activeMessageId: string | null;
  onCardAction?: (
    action: { id: string; kind: "client" | "server"; target?: string },
    document: ImCardDocument,
  ) => void | Promise<void>;
  confirmingId: string | null;
  onWithdraw: (message: ImMessage) => void;
  /** 右键菜单里的撤回：菜单点完就关，没法再做"再点一次确认"，所以这里是直接撤回。 */
  onWithdrawNow: (message: ImMessage) => void;
  onReply: (message: ImMessage) => void;
  onForward: (message: ImMessage) => void;
  onJumpToMessage: (messageId: string) => void;
  onRetryOutbox: (clientMsgId: string) => void;
  onDiscardOutbox: (clientMsgId: string) => void;
  /** 附件要用它取字节（带鉴权的 fetch）；回应要用它提交。 */
  service: IImService | null;
  selfUserId: string | null;
  onToggleReaction: (message: ImMessage, emoji: string, mine: boolean) => void;
  onEdit: (message: ImMessage) => void;
  onTogglePin: (message: ImMessage, pinned: boolean) => void;
  onToggleBookmark: (message: ImMessage, bookmarked: boolean) => void;
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
        // 行本身抽在 ImMessageRow：它自己的动作集（工具条 + 右键 + 引用 + 附件）已经不小，
        // 留在这里会让时间线同时承担"排版"和"一条消息长什么样"两件事。
        return (
          <ImMessageRow
            key={row.key}
            row={row}
            t={t}
            service={service}
            selfUserId={selfUserId}
            selfName={selfName}
            senderNameOf={senderNameOf}
            query={query}
            activeMessageId={activeMessageId}
            {...(onCardAction ? { onCardAction } : {})}
            confirmingId={confirmingId}
            bookmarked={bookmarkedIds.has(row.message.id)}
            onEdit={onEdit}
            onReply={onReply}
            onForward={onForward}
            onWithdraw={onWithdraw}
            onWithdrawNow={onWithdrawNow}
            onJumpToMessage={onJumpToMessage}
            onToggleReaction={onToggleReaction}
            onTogglePin={onTogglePin}
            onToggleBookmark={onToggleBookmark}
          />
        );
      })}

      {/* 本地乐观消息：先画出来，状态随后由发送结果决定。 */}
      {outbox.map((item) => (
        <ImOutboxRow
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
