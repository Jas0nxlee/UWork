import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { IImService } from "@zcode/services";
import type { ImConversationSummary, ImDirectoryUser, ImMessage } from "@zcode/shared";
import { ChevronLeftIcon, MessagesSquareIcon, PanelRightIcon, SearchIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  IM_CONTENT_WIDTH,
  IM_EMPTY,
  IM_EMPTY_ICON,
  IM_EMPTY_TEXT,
  IM_HEADER,
  IM_HEADER_SUBTITLE,
  IM_HEADER_TITLE,
} from "./imChrome.js";
import { ImComposer } from "./ImComposer.js";
import { ImSearchResults } from "./ImSearchResults.js";
import { ImForwardDialog } from "./ImForwardDialog.js";
import { ImTimeline } from "./ImTimeline.js";
import { avatarTone, buildTimeline, initialsOf, type ImTimelineRow } from "./imPresentation.js";
import type { ImOutboxReply } from "./imOutbox.js";
import { useImSearch } from "./useImSearch.js";
import { useImTyping } from "./useImTyping.js";
import { useImWithdraw } from "./useImWithdraw.js";
import { useImConversation } from "./useIm.js";

const draftKey = (conversationId: string): string => `uwork:im-draft:${conversationId}`;

/**
 * 消息区。按企业工作场景的主流组织方式排：**不用气泡**，头像 + 姓名 + 时间 + 正文
 * （Slack / Teams / Discord / Zulip 都收敛到这个形态；气泡只留在消费级 IM）。
 * 理由不只是"跟主流"：气泡会把可用宽度砍掉近一半，而 agent 的产出、代码、日志在气泡里很难看。
 * 滚动交给仓库已有的 StickToBottom（`Conversation`）。
 */
export const ImConversationPanel = memo(function ImConversationPanel({
  service,
  conversationId,
  selfUserId,
  title,
  subtitle,
  nameOf,
  initialLastReadSeq,
  onToggleRightPanel,
  rightPanelOpen,
  onBack,
  conversations,
  directory,
  onForwardMessage,
}: {
  service: IImService | null;
  conversationId: string;
  selfUserId: string | null;
  title: string;
  subtitle?: string;
  nameOf: (id: string) => string | undefined;
  /** 打开时的已读位置：用来插"以下是新消息"分隔线（之后 markRead 会改动它，所以只取首次）。 */
  initialLastReadSeq: number;
  /** 有右侧面板（群设置/线程）时才给这个回调。 */
  onToggleRightPanel?: () => void;
  rightPanelOpen?: boolean;
  /** 面板窄到只剩一栏时，用返回键回到会话列表。 */
  onBack?: () => void;
  /** 转发要用：可选目标会话与通讯录（姓名解析）。 */
  conversations: ImConversationSummary[];
  directory: ImDirectoryUser[];
  /** 转发确认后发给别的会话。由外层做（它持有服务与刷新）。 */
  onForwardMessage: (conversationId: string, body: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const conversation = useImConversation(service, conversationId);
  const [draft, setDraft] = useState("");
  const { confirmingId, actionError, setActionError, onWithdraw, onWithdrawNow, resetWithdraw } =
    useImWithdraw(service, conversationId);
  const [searchOpen, setSearchOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<ImMessage | null>(null);
  const [forwarding, setForwarding] = useState<ImMessage | null>(null);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 未读分隔线只在"进入这个会话的第一次渲染"取值，否则已读上报会把它抹掉。
  const unreadMarkRef = useRef<{ id: string; seq: number }>({
    id: conversationId,
    seq: initialLastReadSeq,
  });
  if (unreadMarkRef.current.id !== conversationId) {
    unreadMarkRef.current = { id: conversationId, seq: initialLastReadSeq };
  }

  // 草稿按会话保存：切来切去不该丢正在打的字。
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    setDraft(localStorage.getItem(draftKey(conversationId)) ?? "");
  }, [conversationId]);
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    if (draft) localStorage.setItem(draftKey(conversationId), draft);
    else localStorage.removeItem(draftKey(conversationId));
  }, [conversationId, draft]);

  // 换会话就把搜索收起来：留着上一个会话的查询词最容易被当成"消息没了"。
  useEffect(() => {
    setSearchOpen(false);
    search.reset();
    // search 是每次渲染新建的对象，故意不放进依赖（只在会话切换时清）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const weekdays = useMemo(
    () => [0, 1, 2, 3, 4, 5, 6].map((day) => intl.formatMessage({ id: `im.weekday.${day}` })),
    [intl],
  );
  const timeLabels = useMemo(
    () => ({
      today: intl.formatMessage({ id: "im.today" }),
      yesterday: intl.formatMessage({ id: "im.yesterday" }),
      weekdays,
    }),
    [intl, weekdays],
  );
  const rows: ImTimelineRow[] = useMemo(
    () =>
      buildTimeline({
        messages: conversation.messages,
        selfUserId,
        unreadAfterSeq: unreadMarkRef.current.seq,
        now: Date.now(),
        dayLabels: timeLabels,
      }),
    [conversation.messages, selfUserId, timeLabels],
  );

  const search = useImSearch(service, conversationId, searchOpen);

  /**
   * 滚动到某条消息，并**测量后纠正**。
   *
   * 为什么要纠正：StickToBottom 在内容变高时会贴底，而"跳转"往往同时带来内容变化
   * （命中不在窗口里 → 先加载上下文），它那次贴底会把我们的 scrollIntoView 盖掉，
   * 结果"高亮了但没在视口里"。这里滚完量一次位置，不对就再来一次（最多三轮）。
   */
  const scrollToMessage = (messageId: string): void => {
    let attempts = 0;
    const run = (): void => {
      attempts += 1;
      const container = rootRef.current;
      const target = container?.querySelector<HTMLElement>(`[data-im-message-id="${messageId}"]`);
      if (!container || !target) return; // 目标不在已加载的窗口里：不假装跳过去了
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const outside =
        targetRect.bottom < containerRect.top || targetRect.top > containerRect.bottom;
      if (outside || attempts === 1) {
        target.scrollIntoView({ block: "center" });
      }
      if (outside && attempts < 3) window.setTimeout(run, 120);
    };
    run();
  };

  /**
   * 跳到某条检索命中：那条通常不在已加载的窗口里，先按 seq 拉它前后的上下文再滚动。
   * 已经在窗口里的就直接滚（省一次往返）。
   */
  const openSearchHit = (message: ImMessage): void => {
    setSearchOpen(false);
    search.reset();
    if (conversation.messages.some((item) => item.id === message.id)) {
      jumpToMessage(message.id);
      return;
    }
    void conversation.loadAround(message.seq).then(() => {
      window.setTimeout(() => jumpToMessage(message.id), 60);
    });
  };

  /**
   * 跳转（引用 / 检索命中）：滚动 + 高亮。
   * 高亮给 2.5 秒——跳进很久以前的历史时，1 秒多不够看清自己落在哪一条。
   */
  const jumpToMessage = (messageId: string): void => {
    setJumpTarget(messageId);
    scrollToMessage(messageId);
    window.setTimeout(
      () => setJumpTarget((current) => (current === messageId ? null : current)),
      2500,
    );
  };

  // 自己的名字拿不到时不要写成"你（你）"。
  // 回车提交时读 ref（submit 不放进依赖回复状态的 useCallback，免得每次改引用都重建）
  const replyToRef = useRef<ImOutboxReply | null>(null);
  replyToRef.current = replyTo
    ? {
        messageId: replyTo.id,
        senderId: replyTo.senderId,
        body: replyTo.body,
      }
    : null;

  const { typingUserIds, notifyTyping } = useImTyping(service, conversationId, selfUserId);
  const typingLabel =
    typingUserIds.length === 0
      ? null
      : intl.formatMessage(
          { id: "im.typing" },
          { name: typingUserIds.map((id) => nameOf(id) ?? id).join("、") },
        );

  const selfName = selfUserId ? nameOf(selfUserId) : undefined;
  const selfLabel = selfName
    ? `${selfName}（${intl.formatMessage({ id: "im.you" })}）`
    : intl.formatMessage({ id: "im.you" });

  const submit = async (): Promise<void> => {
    const body = draft;
    if (!body.trim() || conversation.sending) return;
    const reply = replyToRef.current;
    setDraft("");
    setReplyTo(null);
    setActionError(null);
    const ok = await conversation.send(body, reply);
    if (!ok) setActionError(intl.formatMessage({ id: "im.sendFailed" }));
  };

  /**
   * 附件：先上传拿描述符，再按普通消息发出去（body 是载荷 JSON）。
   * 上传失败不发消息——一个指向不存在附件的消息比"发送失败"更糟。
   */
  const sendFiles = async (files: FileList | null): Promise<void> => {
    if (!service || !files || files.length === 0) return;
    setActionError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, 5)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const attachment = await service.uploadAttachment({
          conversationId,
          name: file.name,
          mime: file.type || "application/octet-stream",
          bytes,
        });
        const ok = await conversation.sendAttachment(
          JSON.stringify({
            attachmentId: attachment.id,
            name: attachment.name,
            mime: attachment.mime,
            size: attachment.size,
          }),
        );
        if (!ok) setActionError(intl.formatMessage({ id: "im.sendFailed" }));
      }
    } catch (error) {
      logger.warn("[im] 附件上传失败", error);
      setActionError(intl.formatMessage({ id: "im.attachmentUploadFailed" }));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <header className={IM_HEADER}>
        {onBack ? (
          <Button
            className="-ml-1 size-7 shrink-0 p-0"
            variant="ghost"
            aria-label={intl.formatMessage({ id: "im.back" })}
            onClick={onBack}
          >
            <ChevronLeftIcon className="size-4" />
          </Button>
        ) : null}
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center text-ui-2xs font-medium",
            title && conversationId
              ? conversationId
                ? "rounded-xl"
                : "rounded-full"
              : "rounded-xl",
            avatarTone(conversationId),
          )}
        >
          {initialsOf(title)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={cn(IM_HEADER_TITLE, "truncate")}>{title}</span>
          {subtitle ? <span className={cn(IM_HEADER_SUBTITLE, "truncate")}>{subtitle}</span> : null}
        </div>
        {conversation.hasMore ? (
          <Button
            className="h-7 shrink-0 rounded-lg px-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            variant="ghost"
            disabled={conversation.loadingOlder}
            onClick={() => void conversation.loadOlder()}
          >
            {conversation.loadingOlder
              ? intl.formatMessage({ id: "im.loading" })
              : intl.formatMessage({ id: "im.loadOlder" })}
          </Button>
        ) : null}
        <Button
          className={cn(
            "size-7 shrink-0 rounded-lg p-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
            searchOpen && "bg-surface text-foreground",
          )}
          variant="ghost"
          aria-label={intl.formatMessage({ id: "im.searchInConversation" })}
          onClick={() => setSearchOpen((open) => !open)}
        >
          <SearchIcon className="size-4" />
        </Button>
        {onToggleRightPanel ? (
          <Button
            className={cn(
              "size-7 shrink-0 rounded-lg p-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
              rightPanelOpen && "bg-surface text-foreground",
            )}
            variant="ghost"
            aria-label={intl.formatMessage({ id: "im.groupSettings" })}
            onClick={onToggleRightPanel}
          >
            <PanelRightIcon className="size-4" />
          </Button>
        ) : null}
      </header>

      {searchOpen ? (
        <ImSearchResults
          query={search.query}
          onQueryChange={search.setQuery}
          results={search.results}
          searching={search.searching}
          hasMore={search.hasMore}
          loadingMore={search.loadingMore}
          error={search.error}
          senderNameOf={nameOf}
          selfUserId={selfUserId}
          onOpenHit={openSearchHit}
          onLoadMore={search.loadMore}
          onClose={() => {
            setSearchOpen(false);
            search.reset();
          }}
        />
      ) : (
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="flex min-h-full flex-col justify-end gap-0 px-4 py-4">
            {!conversation.loaded ? (
              <p className={cn(IM_EMPTY_TEXT, "py-8 text-center")}>
                {intl.formatMessage({ id: "im.loading" })}
              </p>
            ) : rows.length === 0 && conversation.outbox.length === 0 ? (
              <div className={cn(IM_EMPTY, "py-10")}>
                <MessagesSquareIcon className={IM_EMPTY_ICON} />
                <p className={IM_EMPTY_TEXT}>{intl.formatMessage({ id: "im.noMessages" })}</p>
              </div>
            ) : (
              <div className={IM_CONTENT_WIDTH}>
                <ImTimeline
                  rows={rows}
                  outbox={conversation.outbox}
                  selfLabel={selfLabel}
                  senderNameOf={nameOf}
                  query=""
                  activeMessageId={jumpTarget}
                  confirmingId={confirmingId}
                  onWithdraw={onWithdraw}
                  onWithdrawNow={onWithdrawNow}
                  onReply={(message) => {
                    setReplyTo(message);
                    resetWithdraw();
                  }}
                  onForward={(message) => setForwarding(message)}
                  onJumpToMessage={jumpToMessage}
                  onRetryOutbox={(clientMsgId) => void conversation.retry(clientMsgId)}
                  onDiscardOutbox={(clientMsgId) => conversation.discard(clientMsgId)}
                  service={service}
                  selfUserId={selfUserId}
                  onToggleReaction={(message, emoji, mine) => {
                    if (!service) return;
                    const action = mine
                      ? service.removeReaction({ conversationId, messageId: message.id, emoji })
                      : service.addReaction({ conversationId, messageId: message.id, emoji });
                    void action.catch((error: unknown) => logger.warn("[im] 表情操作失败", error));
                  }}
                />
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}

      <ImComposer
        replyTo={replyTo}
        selfUserId={selfUserId}
        selfName={selfName ?? null}
        nameOf={nameOf}
        draft={draft}
        onDraftChange={setDraft}
        sending={conversation.sending}
        uploading={uploading}
        typingLabel={typingLabel}
        actionError={actionError}
        onCancelReply={() => setReplyTo(null)}
        onSubmit={() => void submit()}
        onFiles={(files: FileList | null) => void sendFiles(files)}
        fileInputRef={fileInputRef}
        onTyping={notifyTyping}
      />

      {forwarding ? (
        <ImForwardDialog
          conversations={conversations.filter((item) => item.id !== conversationId)}
          directory={directory}
          selfUserId={selfUserId}
          preview={forwarding.body}
          onPick={(targetId) => {
            onForwardMessage(targetId, forwarding.body);
            setForwarding(null);
          }}
          onClose={() => setForwarding(null)}
        />
      ) : null}
    </div>
  );
});
