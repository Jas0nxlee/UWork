import { memo, useEffect, useRef, useState } from "react";
import type { IImService } from "@zcode/services";
import type { ImMessage } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { useImConversation } from "./useIm.js";

/** 本仓的 IntlInstance 只暴露 formatMessage，时间格式化用系统 locale 就地实现。 */
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * 单个会话的消息时间线 + 输入框。
 * 时间线只渲染服务端给的 `seq` 顺序；撤回的消息留一行"已撤回"占位（tombstone 语义）。
 */
export const ImConversationPanel = memo(function ImConversationPanel({
  service,
  conversationId,
  selfUserId,
  title,
  subtitle,
  onOpenSettings,
}: {
  service: IImService | null;
  conversationId: string;
  selfUserId: string | null;
  title: string;
  subtitle?: string;
  /** 群/频道才有群设置；单聊不传（标题栏就不出现入口）。 */
  onOpenSettings?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const conversation = useImConversation(service, conversationId);
  const [draft, setDraft] = useState("");
  /** 两步确认：撤回会把正文清空且不可恢复，所以第一次点击只把按钮变成「确认撤回」。 */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const withdraw = async (message: ImMessage): Promise<void> => {
    if (!service) return;
    if (confirmingId !== message.id) {
      setConfirmingId(message.id);
      return;
    }
    setConfirmingId(null);
    setActionError(null);
    try {
      await service.withdrawMessage({ conversationId, messageId: message.id });
    } catch (error) {
      logger.warn("[im] 撤回失败", error);
      setActionError(intl.formatMessage({ id: "im.withdrawFailed" }));
    }
  };

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [conversation.messages, conversationId]);

  const submit = async (): Promise<void> => {
    const body = draft;
    if (!body.trim() || conversation.sending) return;
    setDraft("");
    stickToBottom.current = true;
    await conversation.send(body);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-baseline gap-2 border-b border-border px-4 py-2">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        {subtitle ? (
          <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
        ) : null}
        {onOpenSettings ? (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={onOpenSettings}
          >
            {intl.formatMessage({ id: "im.groupSettings" })}
          </button>
        ) : null}
        {conversation.hasMore ? (
          <Button
            className="ml-auto h-6 px-2 text-xs"
            variant="ghost"
            disabled={conversation.loadingOlder}
            onClick={() => void conversation.loadOlder()}
          >
            {conversation.loadingOlder
              ? intl.formatMessage({ id: "im.loading" })
              : intl.formatMessage({ id: "im.loadOlder" })}
          </Button>
        ) : null}
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        onScroll={(event) => {
          const node = event.currentTarget;
          stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
        }}
      >
        {!conversation.loaded ? (
          <p className="text-xs text-muted-foreground">
            {intl.formatMessage({ id: "im.loading" })}
          </p>
        ) : conversation.messages.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {intl.formatMessage({ id: "im.noMessages" })}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {conversation.messages.map((message) => (
              <ImMessageRow
                key={message.id}
                message={message}
                mine={selfUserId !== null && message.senderId === selfUserId}
                time={timeFormatter.format(new Date(message.createdAt))}
                withdrawnLabel={intl.formatMessage({ id: "im.withdrawn" })}
                withdrawLabel={intl.formatMessage({ id: "im.withdraw" })}
                withdrawConfirmLabel={intl.formatMessage({ id: "im.withdrawConfirm" })}
                confirming={confirmingId === message.id}
                onWithdraw={() => void withdraw(message)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2">
        <Textarea
          className="max-h-32 min-h-9 resize-none text-sm"
          placeholder={intl.formatMessage({ id: "im.composerPlaceholder" })}
          value={draft}
          disabled={conversation.sending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            {actionError ?? intl.formatMessage({ id: "im.composerHint" })}
          </span>
          <Button
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={conversation.sending || draft.trim().length === 0}
            onClick={() => void submit()}
          >
            {conversation.sending
              ? intl.formatMessage({ id: "im.sending" })
              : intl.formatMessage({ id: "im.send" })}
          </Button>
        </div>
      </div>
    </div>
  );
});

function ImMessageRow({
  message,
  mine,
  time,
  withdrawnLabel,
  withdrawLabel,
  withdrawConfirmLabel,
  confirming,
  onWithdraw,
}: {
  message: ImMessage;
  mine: boolean;
  time: string;
  withdrawnLabel: string;
  withdrawLabel: string;
  withdrawConfirmLabel: string;
  confirming: boolean;
  onWithdraw: () => void;
}) {
  const withdrawn = message.deletedAt !== null;
  // 只有自己发的、还没撤回的消息可以撤回；服务端同样会再校验一次发送者。
  const canWithdraw = mine && !withdrawn;
  return (
    <li className={cn("group flex w-full flex-col gap-0.5", mine ? "items-end" : "items-start")}>
      <div className={cn("flex max-w-[85%] items-center gap-1.5", mine && "flex-row-reverse")}>
        <div
          className={cn(
            "rounded-lg px-3 py-1.5 text-sm whitespace-pre-wrap break-words",
            withdrawn
              ? "border border-dashed border-border text-xs text-muted-foreground italic"
              : mine
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-foreground",
          )}
        >
          {withdrawn ? withdrawnLabel : message.body}
        </div>
        {canWithdraw ? (
          <button
            type="button"
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap text-muted-foreground transition-opacity hover:bg-accent",
              confirming ? "bg-muted opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
            onClick={onWithdraw}
          >
            {confirming ? withdrawConfirmLabel : withdrawLabel}
          </button>
        ) : null}
      </div>
      <span className="text-[10px] text-muted-foreground">{time}</span>
    </li>
  );
}
