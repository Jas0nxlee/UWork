import { memo, useEffect, useMemo, useState } from "react";
import type { ImConversationSummary, ImDirectoryUser, ImMessage } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { MessagesSidePaneTab } from "@/lib/workspaceSidePane.js";
import { IM_EMPTY, IM_EMPTY_ICON, IM_EMPTY_TEXT, IM_PANEL } from "./imChrome.js";
import { useImBookmarks } from "./useImBookmarks.js";
import {
  clearImOpenRequest,
  setActiveImConversation,
  setImConversationTitles,
  subscribeImNotificationState,
} from "./imNotificationRouter.js";
import { ImBookmarksList } from "./ImBookmarksList.js";
import { ImReportDialogs } from "./ImReportDialogs.js";
import { ImReportsList } from "./ImReportsList.js";
import { ImRightPanel } from "./ImRightPanel.js";
import { ImConversationList } from "./ImConversationList.js";
import { ImConversationPanel } from "./ImConversationPanel.js";
import { ImDirectoryPane } from "./ImDirectoryPane.js";
import { ImListColumn } from "./ImListColumn.js";
import { ImCardReturnDialog } from "./ImCardReturnDialog.js";
import { useImCardActionDispatch } from "./useImCardActionDispatch.js";
import { useImMembers } from "./useImMembers.js";
import { ImNotice, useElementWidth } from "./imPaneChrome.js";
import { ImDirectoryPicker, type ImPickerMode } from "./ImDirectoryPicker.js";
import { MessagesSquareIcon } from "lucide-react";
import { ImRail } from "./ImRail.js";
import {
  conversationSubtitle,
  conversationTitle,
  imListColumnState,
  imPaneBand,
} from "./imPresentation.js";
import { sumUnread, useImPreferences } from "./imPreferences.js";
import { useIm } from "./useIm.js";

/**
 * IM 侧边面板：左列会话、右侧消息。
 *
 * 这里只做展示与交互编排——准入由服务端的白名单决定（`entitlement.enabled === false`
 * 才隐藏内容），未连接、暂不可用等状态区分显示，不要把"查不到"当成"没权限"。
 */
export const MessagesSidePane = memo(function MessagesSidePane({
  tab,
}: {
  tab: MessagesSidePaneTab;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>): string =>
    intl.formatMessage({ id }, values);
  const im = useIm();
  const { preferences } = useImPreferences();
  const [selected, setSelected] = useState<string | null>(tab.conversationId ?? null);
  const [directory, setDirectory] = useState<ImDirectoryUser[]>([]);
  const [picking, setPicking] = useState(false);
  const [pickerMode, setPickerMode] = useState<ImPickerMode>("dm");
  /** 右栏：单聊显示对方的名片式成员栏，群显示成员 + 设置入口。 */
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  /** 右栏的两种内容：成员面板（默认）与群设置（管理操作）。 */
  const [rightPanelMode, setRightPanelMode] = useState<"members" | "settings">("members");
  /** 左侧 rail 的当前入口（消息 / 通讯录）。 */
  const [railView, setRailView] = useState<"messages" | "directory" | "bookmarks" | "reports">(
    "messages",
  );
  /**
   * 通知与角标的路由：告诉它"我现在在看哪个会话"（在看的会话不弹通知），
   * 并消费"点通知要打开某会话"的请求。开关放在真正的挂载点（面板）上，语义最准。
   */
  useEffect(() => {
    setActiveImConversation(selected);
    return () => setActiveImConversation(null);
  }, [selected]);
  useEffect(
    () =>
      subscribeImNotificationState((state) => {
        if (!state.openRequest) return;
        setSelected(state.openRequest);
        setRailView("messages");
        clearImOpenRequest();
      }),
    [],
  );

  /** 收藏：侧边栏持有（rail 的收藏视图与右键菜单要共用一个实例，否则两边不同步）。 */
  const bookmarks = useImBookmarks(im.service);
  /**
   * 打开收藏视图就重拉一次。
   *
   * 不能只在挂载时拉：那次请求一旦失败（网关刚上线、路由还没通、网络抖动），`loaded` 会永远是
   * false，而右键的收藏动作又按 `loaded` 决定要不要刷新——列表就永远空着，看起来像"收藏没生效"。
   * 打开视图重拉一次的成本是一次请求，换掉这个自己回不来的状态。
   */
  useEffect(() => {
    if (railView !== "bookmarks") return;
    void bookmarks.refresh();
  }, [railView, bookmarks.refresh]);
  /** 置顶消息由面板拉取（它才知道当前会话），右栏只是渲染。 */
  const [pinned, setPinned] = useState<ImMessage[]>([]);
  const [showPinned, setShowPinned] = useState(false);
  /** 跳转请求（右栏置顶 / 全局检索命中）：seq 是会话内坐标，换会话后靠它拉上下文。 */
  const [jumpRequest, setJumpRequest] = useState<{
    conversationId: string;
    id: string;
    seq: number;
    at: number;
  } | null>(null);
  /** 汇报：详情弹窗的 id / 写汇报弹窗是否打开 / 提交后刷新列表的令牌。 */
  const [openReportId, setOpenReportId] = useState<string | null>(null);
  const [composingReport, setComposingReport] = useState(false);
  const [reportsRefreshToken, setReportsRefreshToken] = useState(0);
  // 宽度用回调 ref 量：面板在加载态/无权限时不渲染那一层，晚挂载也要能量到（否则档位永远停在兜底值）。
  const { measureRef: paneMeasureRef, width: paneWidth } = useElementWidth();
  const band = imPaneBand(paneWidth);
  /** 窄档：列表折叠成浮层（点 rail 或会话头部返回键打开，选完自动收）。 */
  const [listOverlayOpen, setListOverlayOpen] = useState(false);
  const listColumn = imListColumnState({ band, listOverlayOpen, railView });
  // 切档自动收浮层：宽了就停靠显示，不用用户再点一下
  useEffect(() => {
    if (band !== "narrow") setListOverlayOpen(false);
  }, [band]);
  // 卡片动作的分派（server 动作的执行者）：解决"按钮画出来但没人执行"（§12.18）。
  const cardActions = useImCardActionDispatch({
    service: im.service,
    onOpenItem: (itemId) => setOpenReportId(itemId),
  });

  const compactPanel = paneWidth > 0 && paneWidth < 700;

  // DM 的标题要从 dmKey 里认出对方（服务端存的是排序后的两个成员 id），名字取自通讯录。
  // 通讯录规模很小（一期 14 人），进面板拉一次就够。
  useEffect(() => {
    if (!im.service) return;
    let active = true;
    void im.service
      .searchDirectory("")
      .then((users) => {
        if (active) setDirectory(users);
      })
      .catch((error: unknown) => {
        logger.warn("[im] 读取通讯录失败", error);
      });
    return () => {
      active = false;
    };
  }, [im.service]);

  const nameById = useMemo(() => new Map(directory.map((user) => [user.id, user])), [directory]);
  const selfUserId = im.view?.selfUserId ?? null;
  const nameOf = (id: string): string | undefined => nameById.get(id)?.name ?? undefined;
  const titleOf = (summary: ImConversationSummary): string =>
    conversationTitle(summary, selfUserId, nameOf, t("im.untitled"));

  // 这两行必须在早返回（未加载/无权限）之前：hooks 不能有条件地调用。
  const conversations = im.view?.conversations ?? [];
  // rail 角标 = 未读总数（静音的会话不计入，与侧栏入口一个口径）。
  const unreadTotal = useMemo(
    () => sumUnread(conversations, preferences),
    [conversations, preferences],
  );

  // 成员详情（含在线状态）由 hook 管：两个订阅必须一起改，见 useImMembers。
  const members = useImMembers(im.service, selected);

  // 通知标题要显示"谁发来的"：单聊用对面姓名，群用群名——只有这里知道怎么解析
  useEffect(() => {
    const titles: Record<string, string> = {};
    for (const conversation of conversations) {
      titles[conversation.id] = conversationTitle(
        conversation,
        selfUserId,
        nameOf,
        t("im.untitled"),
      );
    }
    setImConversationTitles(titles);
  }, [conversations, selfUserId, nameOf, t]);

  const subtitleOf = (summary: ImConversationSummary): string =>
    summary.kind === "dm"
      ? conversationSubtitle(summary, selfUserId, (id) => nameById.get(id))
      : members.length === 0
        ? ""
        : t("im.memberCount", { count: members.length });

  if (!im.available) {
    return <ImNotice text={t("im.unavailableInHost")} />;
  }
  if (!im.loaded) {
    return <ImNotice text={t("im.loading")} />;
  }
  const entitlement = im.view?.entitlement ?? null;
  if (entitlement && !entitlement.enabled) {
    return <ImNotice text={t("im.notInAllowlist")} />;
  }

  const active = conversations.find((conversation) => conversation.id === selected) ?? null;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", IM_PANEL)}>
      {im.view?.lastError ? (
        <p className="shrink-0 border-b border-border bg-surface px-3 py-1.5 text-ui-2xs text-foreground-subtle">
          {im.view.lastError}
        </p>
      ) : null}

      <div
        ref={paneMeasureRef}
        data-pane-width={Math.round(paneWidth)}
        data-pane-state={`${band}/${railView}`}
        className="relative flex min-h-0 flex-1"
      >
        <ImRail
          view={railView}
          unreadTotal={unreadTotal}
          selfName={(selfUserId ? nameOf(selfUserId) : undefined) ?? t("im.you")}
          onSelect={(next) => {
            // 窄档下列表不是一栏：再点「消息」= 打开/收起列表浮层（不然点了像没反应）
            if (next === "messages" && band === "narrow") setListOverlayOpen((open) => !open);
            setRailView(next);
            if (next === "messages") setPicking(false);
          }}
        />

        <ImListColumn
          state={listColumn}
          backdropLabel={t("common.close")}
          onBackdrop={() => setListOverlayOpen(false)}
        >
          {picking ? (
            <ImDirectoryPicker
              users={directory}
              mode={pickerMode}
              onModeChange={setPickerMode}
              onPickDm={(user) => {
                if (!im.service) return;
                void im.service
                  .createDm(user.id)
                  .then((conversation) => {
                    setSelected(conversation.id);
                    setPicking(false);
                  })
                  .catch((error: unknown) => logger.warn("[im] 发起单聊失败", error));
              }}
              onCreateGroup={(memberIds, title) => {
                if (!im.service) return;
                void im.service
                  .createGroup({ memberIds, title: title || t("im.untitled") })
                  .then((conversation) => {
                    setSelected(conversation.id);
                    setPicking(false);
                  })
                  .catch((error: unknown) => logger.warn("[im] 建群失败", error));
              }}
              onClose={() => setPicking(false)}
            />
          ) : null}
          <ImConversationList
            conversations={conversations}
            directory={directory}
            selfUserId={selfUserId}
            selectedId={selected}
            onSelect={(conversationId) => {
              setSelected(conversationId);
              // 窄档：选完会话把浮层收起来，否则用户以为"点了没反应"（浮层还盖在上面）
              setListOverlayOpen(false);
            }}
            onNewConversation={() => setPicking(true)}
            onRefresh={() => void im.refresh()}
            onMarkRead={(conversation) => {
              if (!im.service) return;
              // 标记到最新一条：服务端会把 seq 夹到 lastSeq，多传也不会越界。
              void im.service
                .markRead({ conversationId: conversation.id, seq: conversation.lastSeq })
                .then(() => im.refresh())
                .catch((error: unknown) => logger.warn("[im] 标记已读失败", error));
            }}
          />
        </ImListColumn>

        <div className={cn("min-w-0 flex-1", railView !== "messages" && "hidden")}>
          {active ? (
            <ImConversationPanel
              service={im.service}
              conversationId={active.id}
              selfUserId={selfUserId}
              title={titleOf(active)}
              subtitle={subtitleOf(active)}
              nameOf={nameOf}
              initialLastReadSeq={active.lastReadSeq}
              onBack={band === "narrow" ? () => setListOverlayOpen(true) : undefined}
              rightPanelOpen={rightPanelOpen}
              jumpRequest={jumpRequest}
              onPinnedChange={setPinned}
              onOpenConversation={(targetId, messageId, seq) => {
                setSelected(targetId);
                setJumpRequest({ conversationId: targetId, id: messageId, seq, at: Date.now() });
              }}
              onToggleRightPanel={() => setRightPanelOpen((open) => !open)}
              conversations={conversations}
              directory={directory}
              members={members}
              bookmarkedIds={bookmarks.ids}
              onToggleBookmark={(messageId, bookmarked) =>
                void bookmarks.toggle(messageId, bookmarked)
              }
              onCardAction={cardActions.dispatch}
              onForwardMessage={(targetId, body) => {
                if (!im.service) return;
                // 转发就是"把同一条正文发到另一个会话"：服务端会再校验一次成员资格。
                void im.service
                  .sendMessage({ conversationId: targetId, body })
                  .then(() => im.refresh())
                  .catch((error: unknown) => logger.warn("[im] 转发失败", error));
              }}
            />
          ) : (
            <div className={IM_EMPTY}>
              <MessagesSquareIcon className={IM_EMPTY_ICON} />
              <p className={IM_EMPTY_TEXT}>{t("im.pickConversation")}</p>
            </div>
          )}
        </div>

        {railView === "reports" ? (
          <ImReportsList
            service={im.service}
            selfUserId={selfUserId}
            nameOf={nameOf}
            refreshToken={reportsRefreshToken}
            onOpen={(reportId) => setOpenReportId(reportId)}
            onCompose={() => setComposingReport(true)}
          />
        ) : null}

        {railView === "bookmarks" ? (
          <ImBookmarksList
            items={bookmarks.items}
            // 单聊的 title 在服务端是空的（标题是"对方是谁"，由客户端按成员算出来）。
            // 这里必须走和会话列表同一个 titleOf，否则收藏列表会把单聊显示成"未命名会话"，
            // 而左边同一行明明写着对方的名字——两处口径不一致比不给名字更让人困惑。
            conversationTitleOf={(item) => {
              const summary = conversations.find(
                (conversation) => conversation.id === item.message.conversationId,
              );
              return (
                (summary ? titleOf(summary) : null) ?? item.conversationTitle ?? t("im.untitled")
              );
            }}
            senderNameOf={nameOf}
            selfUserId={selfUserId}
            onOpen={(item) => {
              // 收藏可能在别的会话：先切过去，再按 seq 跳（面板按 conversationId 过滤跳转请求）
              setSelected(item.message.conversationId);
              setRailView("messages");
              setJumpRequest({
                conversationId: item.message.conversationId,
                id: item.message.id,
                seq: item.message.seq,
                at: Date.now(),
              });
            }}
          />
        ) : null}

        {railView === "directory" ? (
          <ImDirectoryPane
            service={im.service}
            users={directory}
            onOpened={(conversationId) => {
              setRailView("messages");
              setSelected(conversationId);
            }}
          />
        ) : null}

        <ImRightPanel
          active={active}
          open={rightPanelOpen}
          compact={compactPanel}
          mode={rightPanelMode}
          onModeChange={setRightPanelMode}
          showPinned={showPinned}
          pinned={pinned}
          service={im.service}
          directory={directory}
          members={members}
          selfUserId={selfUserId}
          nameOf={nameOf}
          onOpenPinned={(message) =>
            // 置顶列表属于当前选中的会话
            setJumpRequest({
              conversationId: selected ?? "",
              id: message.id,
              seq: message.seq,
              at: Date.now(),
            })
          }
          onShowPinned={() => setShowPinned(true)}
          onClose={() => setRightPanelOpen(false)}
          onChanged={() => void im.refresh()}
        />
      </div>

      <ImReportDialogs
        service={im.service}
        selfUserId={selfUserId}
        directory={directory}
        composing={composingReport}
        openReportId={openReportId}
        nameOf={nameOf}
        onCloseCompose={() => setComposingReport(false)}
        onCloseDetail={() => setOpenReportId(null)}
        onSubmitted={({ conversationId }) => {
          // 提交后：收起弹窗、刷新记录、切到那条会话——用户立刻能看到自己发出去的那张卡
          setComposingReport(false);
          setReportsRefreshToken((token) => token + 1);
          setSelected(conversationId);
          setRailView("messages");
        }}
      />
      {cardActions.returningReview ? (
        <ImCardReturnDialog
          service={im.service}
          itemId={cardActions.returningReview.itemId}
          title={cardActions.returningReview.title}
          onClose={cardActions.closeReturn}
        />
      ) : null}
    </div>
  );
});
