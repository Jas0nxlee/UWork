import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ImConversationSummary, ImDirectoryUser, ImMember, ImMessage } from "@zcode/shared";
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
import { ImConversationList } from "./ImConversationList.js";
import { ImConversationPanel } from "./ImConversationPanel.js";
import { ImDirectoryList } from "./ImDirectoryList.js";
import { ImDirectoryPicker, type ImPickerMode } from "./ImDirectoryPicker.js";
import { ImGroupSettings } from "./ImGroupSettings.js";
import { ImMemberPanel } from "./ImMemberPanel.js";
import { MessagesSquareIcon } from "lucide-react";
import { ImRail } from "./ImRail.js";
import { ImPinnedPanel } from "./ImPinnedPanel.js";
import { conversationSubtitle, conversationTitle } from "./imPresentation.js";
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
  const [railView, setRailView] = useState<"messages" | "directory" | "bookmarks">("messages");
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
  const paneRef = useRef<HTMLDivElement | null>(null);
  const paneWidth = useElementWidth(paneRef);
  const singleColumn = paneWidth > 0 && paneWidth < 460;
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

  // 成员面板与表头人数都来自这一份详情（一次请求，两个用途），切走时取消。
  const [members, setMembers] = useState<ImMember[]>([]);
  useEffect(() => {
    setMembers([]);
    if (!im.service || !selected) return;
    let active = true;
    const load = (): void => {
      void im.service
        ?.listMemberDetails(selected)
        .then((details) => {
          if (active) setMembers(details);
        })
        .catch((error: unknown) => {
          logger.warn("[im] 读取成员失败", error);
        });
    };
    load();
    // 在线状态只来自服务端：连接恢复后重新拉一次，避免面板停在"全部离线"。
    const subscription = im.service.onRealtime((event) => {
      const realtime = event as { kind?: string; conversationId?: string };
      if (realtime.kind === "presence" && realtime.conversationId === selected) load();
    });
    return () => {
      active = false;
      subscription.dispose();
    };
  }, [im.service, selected]);

  // 在线状态变化也要反映到成员详情里（不重拉全量：presence 帧只带"谁变了"）。
  useEffect(() => {
    if (!im.service) return;
    const subscription = im.service.onRealtime((event) => {
      const realtime = event as {
        kind?: string;
        conversationId?: string;
        userId?: string;
        online?: boolean;
      };
      if (realtime.kind !== "presence" || realtime.conversationId !== selected) return;
      setMembers((current) =>
        current.map((member) =>
          member.id === realtime.userId ? { ...member, online: realtime.online === true } : member,
        ),
      );
    });
    return () => subscription.dispose();
  }, [im.service, selected]);

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

      <div ref={paneRef} className="relative flex min-h-0 flex-1">
        <ImRail
          view={railView}
          unreadTotal={unreadTotal}
          selfName={(selfUserId ? nameOf(selfUserId) : undefined) ?? t("im.you")}
          onSelect={(next) => {
            setRailView(next);
            if (next === "messages") setPicking(false);
          }}
        />

        <div
          className={cn(
            "flex w-60 shrink-0 flex-col border-r border-border",
            // 面板能被拖到 240px 宽。窄到放不下两栏时退成单栏（列表/会话二选一），
            // 否则会把消息列挤到几十像素，比"多一栏"更糟。
            (singleColumn || railView === "directory") && "hidden",
          )}
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
            onSelect={(conversationId) => setSelected(conversationId)}
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
        </div>

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
              onBack={singleColumn ? () => setSelected(null) : undefined}
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

        {railView === "bookmarks" && !singleColumn ? (
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

        {/* 通讯录：占列表位置，复用同一套列表视觉；点一个人直接开单聊。
            不在这里放"建群"——那是新建动作，属于区头的 + 号。 */}
        {railView === "directory" && !singleColumn ? (
          <ImDirectoryList
            users={directory}
            onPick={(user) => {
              if (!im.service) return;
              void im.service
                .createDm(user.id)
                .then((conversation) => {
                  setRailView("messages");
                  setSelected(conversation.id);
                })
                .catch((error: unknown) => logger.warn("[im] 发起单聊失败", error));
            }}
          />
        ) : null}

        {/* 右栏：成员面板（默认）/ 群设置。放不下时改成浮层盖在消息列上——
            直接塞一列会把消息挤没，直接不显示又等于功能消失。 */}
        {active && rightPanelOpen ? (
          <div
            className={cn(
              "w-64 border-l border-border",
              compactPanel ? "absolute inset-y-0 right-0 z-20 shadow-xl" : "relative shrink-0",
            )}
          >
            {showPinned ? (
              <ImPinnedPanel
                pinned={pinned}
                senderNameOf={nameOf}
                selfUserId={selfUserId}
                onOpen={(message) =>
                  setJumpRequest({
                    // 置顶列表属于当前选中的会话
                    conversationId: selected ?? "",
                    id: message.id,
                    seq: message.seq,
                    at: Date.now(),
                  })
                }
              />
            ) : rightPanelMode === "settings" && active.kind !== "dm" ? (
              <ImGroupSettings
                service={im.service}
                conversation={active}
                directory={directory}
                selfUserId={selfUserId}
                onClose={() => setRightPanelMode("members")}
                onChanged={() => void im.refresh()}
              />
            ) : (
              <ImMemberPanel
                members={members}
                directory={directory}
                selfUserId={selfUserId}
                onOpenSettings={
                  active.kind === "dm" ? undefined : () => setRightPanelMode("settings")
                }
                onShowPinned={() => setShowPinned(true)}
                pinnedCount={pinned.length}
                onClose={() => setRightPanelOpen(false)}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
});

/** 观察某个元素的宽度；侧边面板可被拖动，布局要跟着实际宽度走而不是窗口宽度。 */
function useElementWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    setWidth(Math.round(element.getBoundingClientRect().width));
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function ImNotice({ text }: { text: string }) {
  return (
    <div className={cn(IM_EMPTY, IM_PANEL)}>
      <MessagesSquareIcon className={IM_EMPTY_ICON} />
      <p className={IM_EMPTY_TEXT}>{text}</p>
    </div>
  );
}
