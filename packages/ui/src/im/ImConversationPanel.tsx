import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { IImService } from "@zcode/services";
import type {
  ImConversation,
  ImConversationSummary,
  ImDirectoryUser,
  ImMember,
  ImMessage,
  ImCardDocument,
} from "@zcode/shared";
import { MessagesSquareIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { IM_CONTENT_WIDTH, IM_EMPTY, IM_EMPTY_ICON, IM_EMPTY_TEXT } from "./imChrome.js";
import { ImComposer } from "./ImComposer.js";
import { ImSearchResults } from "./ImSearchResults.js";
import { ImForwardDialog } from "./ImForwardDialog.js";
import { ImTimeline } from "./ImTimeline.js";
import { buildTimeline, conversationTitle, type ImTimelineRow } from "./imPresentation.js";
import { ImConversationHeader } from "./ImConversationHeader.js";
import { useImMessageActions } from "./useImMessageActions.js";
import { useImComposerState } from "./useImComposerState.js";
import { useImJumpToMessage } from "./useImJumpToMessage.js";
import { useImPinnedMessages } from "./useImPinned.js";
import { useImSearch, type ImSearchScope } from "./useImSearch.js";
import { useImTyping } from "./useImTyping.js";
import { useImWithdraw } from "./useImWithdraw.js";
import { useImConversation } from "./useIm.js";

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
  members,
  bookmarkedIds,
  onToggleBookmark,
  jumpRequest,
  onPinnedChange,
  onOpenConversation,
  onForwardMessage,
  onCardAction,
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
  /** 会话成员：@提及的候选来自这里（只有群/频道才给候选）。 */
  members: ImMember[];
  /** 收藏集合与切换由外层持有（收藏视图与这里共用一份）。 */
  bookmarkedIds: ReadonlySet<string>;
  onToggleBookmark: (messageId: string, bookmarked: boolean) => void;
  /** 跳转请求（右栏置顶 / 全局检索命中）：面板持有时间线的 DOM，所以由它执行。 */
  jumpRequest?: { conversationId: string; id: string; seq: number; at: number } | null;
  /** 置顶列表变化时上报（右栏由侧边栏渲染）。 */
  onPinnedChange?: (pinned: ImMessage[]) => void;
  /** 全局检索命中别的会话：切过去并按 seq 跳转（外层才知道怎么切会话）。 */
  onOpenConversation?: (conversationId: string, messageId: string, seq: number) => void;
  /** 转发确认后发给别的会话。由外层做（它持有服务与刷新）。 */
  onForwardMessage: (conversationId: string, body: string) => void;
  /** 卡片的 client 动作（如打开汇报详情）；由外层处理。 */
  onCardAction?: (
    action: { id: string; kind: "client" | "server"; target?: string },
    document: ImCardDocument,
  ) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const conversation = useImConversation(service, conversationId);
  const { confirmingId, onWithdraw, onWithdrawNow, resetWithdraw } = useImWithdraw(
    service,
    conversationId,
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchScope, setSearchScope] = useState<ImSearchScope>("conversation");
  const search = useImSearch(service, conversationId, searchOpen, searchScope);
  const [forwarding, setForwarding] = useState<ImMessage | null>(null);
  // 收藏与置顶都由面板持有，再传给时间线与右栏（收藏是"我的"，置顶是"会话的"）
  const { pinned, refresh: refreshPinned } = useImPinnedMessages(service, conversationId);
  useEffect(() => {
    onPinnedChange?.(pinned);
  }, [pinned, onPinnedChange]);

  const actions = useImMessageActions({
    service,
    conversationId,
    onPinnedChanged: refreshPinned,

    onStartEdit: (message) => {
      setEditing(message);
      setActionError(null);
    },
  });

  // 未读分隔线只在"进入这个会话的第一次渲染"取值，否则已读上报会把它抹掉。
  const unreadMarkRef = useRef<{ id: string; seq: number }>({
    id: conversationId,
    seq: initialLastReadSeq,
  });
  if (unreadMarkRef.current.id !== conversationId) {
    unreadMarkRef.current = { id: conversationId, seq: initialLastReadSeq };
  }

  // 换会话就把搜索收起来：留着上一个会话的查询词最容易被当成"消息没了"。
  useEffect(() => {
    setEditing(null);
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

  // 跳转（右栏置顶/收藏、检索命中）：加载上下文 + 滚动 + 高亮，见 useImJumpToMessage
  const { jumpTarget, jumpToMessage, openSearchHit } = useImJumpToMessage({
    rootRef,
    conversationId,
    messages: conversation.messages,
    loadAround: conversation.loadAround,
    onOpenConversation,
    onBeforeJump: () => {
      setSearchOpen(false);
      search.reset();
    },
    jumpRequest,
  });
  // 输入区：草稿/回复/提及/编辑/附件，见 useImComposerState
  const {
    draft,
    setDraft,
    replyTo,
    setReplyTo,
    mentions,
    setMentions,
    editing,
    setEditing,
    uploading,
    actionError,
    setActionError,
    fileInputRef,
    submit,
    submitEdit,
    sendFiles,
  } = useImComposerState({ service, conversationId, conversation, onEdited: jumpToMessage });

  // 自己的名字拿不到时不要写成"你（你）"。
  const { typingUserIds, notifyTyping } = useImTyping(service, conversationId, selfUserId);
  // @提及的候选：群/频道给成员 + 全体；单聊不给（两个人不用 @）
  const mentionCandidates = useMemo(() => {
    if (!conversationId || members.length === 0) return [];
    const people = members
      .filter((member) => member.id !== selfUserId)
      .map((member) => ({ id: member.id, name: nameOf(member.id) ?? member.id }));
    return [{ id: "all", name: intl.formatMessage({ id: "im.mentionAll" }) }, ...people];
  }, [conversationId, members, selfUserId, nameOf, intl]);
  /**
   * 全局检索结果里的"这条来自哪个会话"标签。
   *
   * 服务端的全局检索只回 `{ title, kind }`——单聊的 title 本来就是空的（标题是"对方是谁"，
   * 由客户端按成员算），直接显示会变成"未命名会话"，而左边列表里同一会话写着对方的名字。
   * 所以先用面板手里的会话列表（带 dmKey）解析，解析不到才退回服务端给的 title。
   */
  const searchConversationTitles = useMemo(() => {
    const resolved: Record<string, { title: string | null; kind: ImConversation["kind"] }> = {};
    for (const [id, info] of Object.entries(search.conversations)) {
      const local = conversations.find((conversation) => conversation.id === id);
      resolved[id] = {
        ...info,
        title: local
          ? conversationTitle(local, selfUserId, nameOf, intl.formatMessage({ id: "im.untitled" }))
          : info.title,
      };
    }
    return resolved;
  }, [search.conversations, conversations, selfUserId, nameOf, intl]);

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

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <ImConversationHeader
        title={title}
        subtitle={subtitle}
        avatarSeed={conversationId}
        hasMore={conversation.hasMore}
        loadingOlder={conversation.loadingOlder}
        searchOpen={searchOpen}
        rightPanelOpen={rightPanelOpen}
        onBack={onBack}
        onLoadOlder={() => void conversation.loadOlder()}
        onToggleSearch={() => setSearchOpen((open) => !open)}
        onToggleRightPanel={onToggleRightPanel}
      />

      {searchOpen ? (
        <ImSearchResults
          query={search.query}
          onQueryChange={search.setQuery}
          scope={searchScope}
          onScopeChange={setSearchScope}
          conversations={searchConversationTitles}
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
                  selfName={selfName ?? null}
                  senderNameOf={nameOf}
                  bookmarkedIds={bookmarkedIds}
                  query=""
                  activeMessageId={jumpTarget}
                  {...(onCardAction ? { onCardAction } : {})}
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
                  onEdit={actions.startEdit}
                  onTogglePin={actions.togglePin}
                  onToggleBookmark={(message, bookmarked) =>
                    onToggleBookmark(message.id, bookmarked)
                  }
                  onToggleReaction={actions.toggleReaction}
                />
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}

      <ImComposer
        editing={editing}
        onEditSave={(body) => void submitEdit(body)}
        onEditCancel={() => setEditing(null)}
        mentionCandidates={mentionCandidates}
        mentions={mentions}
        onMentionsChange={setMentions}
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
        // 提及 id 必须带着走：漏掉这一层（`onSubmit={() => submit()}`）会让 @ 只变成正文里的
        // 一串文字——本地看着高亮，服务端 mention_ids 是空的，收方的"提到我"永远不亮。
        onSubmit={(mentionIds) => void submit(mentionIds)}
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
