import { memo, useMemo, useState } from "react";
import {
  parseImAttachmentBody,
  type ImConversationSummary,
  type ImDirectoryUser,
} from "@zcode/shared";
import {
  BellOffIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PinIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import {
  IM_CHROME,
  IM_DIVIDER_X,
  IM_EMPTY,
  IM_EMPTY_ICON,
  IM_EMPTY_TEXT,
  IM_LIST_GROUP_LABEL,
  IM_LIST_NAME,
  IM_LIST_PADDING,
  IM_LIST_PREVIEW,
  IM_LIST_ROW,
  IM_LIST_ROW_ACTIVE,
  IM_LIST_ROW_MARKER,
  IM_LIST_ROW_IDLE,
  IM_LIST_TIME,
  IM_SEARCH_INPUT,
  IM_UNREAD_DOT,
  IM_UNREAD_PILL,
} from "./imChrome.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { applyConversationPreferences, preferenceOf, useImPreferences } from "./imPreferences.js";
import { describeSystemMessage } from "./imSystemMessage.js";
import {
  avatarTone,
  conversationPreview,
  conversationTitle,
  formatListTime,
  initialsOf,
} from "./imPresentation.js";

/**
 * 会话列表：按成熟 IM 的组织方式排——每行给出头像、名称、预览、时间、未读五项，
 * 顶部一个搜索框（本地过滤），选中/悬停有明确反馈。
 *
 * 置顶/静音是本地偏好，所以这一层自己读写（见 `imPreferences.ts`）：
 * 列表要按置顶重排、行上要显示标记，侧栏角标要排除静音——三处共用同一个判定。
 */
export const ImConversationList = memo(function ImConversationList({
  conversations,
  directory,
  selfUserId,
  selectedId,
  onSelect,
  onNewConversation,
  onRefresh,
  onMarkRead,
}: {
  conversations: ImConversationSummary[];
  directory: ImDirectoryUser[];
  selfUserId: string | null;
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  onNewConversation: () => void;
  onRefresh: () => void;
  /** 右键菜单里"标记已读"：把这会话标记到最新一条（服务端会夹到 lastSeq）。 */
  onMarkRead: (conversation: ImConversationSummary) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>): string =>
    intl.formatMessage({ id }, values);
  const [query, setQuery] = useState("");
  const { preferences, toggle } = useImPreferences();

  const byId = useMemo(() => new Map(directory.map((user) => [user.id, user])), [directory]);
  const nameOf = (id: string): string | undefined => byId.get(id)?.name ?? undefined;

  const weekdays = useMemo(
    () => [0, 1, 2, 3, 4, 5, 6].map((day) => t(`im.weekday.${day}`)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [intl],
  );
  const now = Date.now();
  const timeLabels = { today: t("im.today"), yesterday: t("im.yesterday"), weekdays };

  /**
   * 列表预览。系统消息的 body 是 JSON 载荷，**直接当预览显示就会漏出 `{"action":...}`**——
   * 这里统一渲染成人话；将来加新的预览来源（附件名、语音时长）也走这一个口子。
   */
  const previewOf = (conversation: ImConversationSummary): { text: string; prefix: string } => {
    const last = conversation.lastMessage;
    if (last && last.kind === "system") {
      return { text: describeSystemMessage(last.body, nameOf, t).text, prefix: "" };
    }
    if (last && last.kind === "attachment" && last.deletedAt === null) {
      const attachment = parseImAttachmentBody(last.body);
      if (attachment) {
        const isImage = /^image\//i.test(attachment.mime);
        return {
          text: `${isImage ? t("im.previewImage") : t("im.previewFile")} ${attachment.name}`,
          prefix:
            last.senderId === selfUserId
              ? "you:"
              : conversation.kind === "dm"
                ? ""
                : `${(nameOf(last.senderId) ?? "").split(/\s+/)[0]}:`,
        };
      }
    }
    return conversationPreview(conversation, selfUserId, nameOf);
  };

  const sorted = applyConversationPreferences(conversations, preferences);
  const filtered = sorted.filter((conversation) => {
    if (!query) return true;
    const title = conversationTitle(conversation, selfUserId, nameOf, "");
    const preview = previewOf(conversation).text;
    return title.includes(query) || preview.includes(query);
  });

  /**
   * 分组标题（设计稿里的 `.cat`）。
   * 分组用**真实事实**：置顶是用户自己钉的，单聊/群聊是会话的类型——不按"未读/最近"造分类，
   * 那类分类会和排序打架，用户找不到东西。搜索时不分（搜索结果本身就是一组）。
   */
  const groups: { key: string; title: string; items: ImConversationSummary[] }[] = query
    ? [{ key: "all", title: t("im.groupSearch"), items: filtered }]
    : [
        {
          key: "pinned",
          title: t("im.groupPinned"),
          items: filtered.filter((item) => preferenceOf(preferences, item.id).pinned),
        },
        {
          key: "dm",
          title: t("im.groupDirect"),
          items: filtered.filter(
            (item) => item.kind === "dm" && !preferenceOf(preferences, item.id).pinned,
          ),
        },
        {
          key: "group",
          title: t("im.groupGroup"),
          items: filtered.filter(
            (item) => item.kind !== "dm" && !preferenceOf(preferences, item.id).pinned,
          ),
        },
      ].filter((group) => group.items.length > 0);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col border-r", IM_DIVIDER_X, IM_CHROME)}>
      {/* 不再放列表标题：面板 tab 与列头都已经表达了"消息"，再写一遍就是三处重复。
          这一行只放"在列表上能做的事"：搜索、新建、刷新。 */}
      <div className="flex shrink-0 items-center gap-1 px-3 pt-3 pb-1">
        <Input
          className={cn(IM_SEARCH_INPUT, "flex-1")}
          placeholder={t("im.searchPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-8 shrink-0 rounded-lg p-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          title={t("im.newDm")}
          aria-label={t("im.newDm")}
          onClick={onNewConversation}
        >
          <PlusIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-8 shrink-0 rounded-lg p-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          title={t("im.refresh")}
          aria-label={t("im.refresh")}
          onClick={onRefresh}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
      </div>

      <ul className={cn("min-h-0 flex-1 overflow-y-auto py-1", IM_LIST_PADDING)}>
        {filtered.length === 0 ? (
          <li className={cn(IM_EMPTY, "py-10")}>
            <MessagesSquareIcon className={IM_EMPTY_ICON} />
            <span className={IM_EMPTY_TEXT}>
              {conversations.length === 0 ? t("im.noConversations") : t("im.noSearchResult")}
            </span>
          </li>
        ) : (
          groups.flatMap((group) => [
            <li
              key={`cat-${group.key}`}
              data-testid="im-conversation-group"
              className={IM_LIST_GROUP_LABEL}
            >
              {group.title}
            </li>,
            ...group.items.map((conversation) => {
              const title = conversationTitle(conversation, selfUserId, nameOf, t("im.untitled"));
              const preview = previewOf(conversation);
              const selected = conversation.id === selectedId;
              const preference = preferenceOf(preferences, conversation.id);
              const unread = conversation.unreadCount;
              return (
                <li key={conversation.id} className="group/row relative">
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        data-testid="im-conversation-row"
                        className={cn(
                          IM_LIST_ROW,
                          selected ? IM_LIST_ROW_ACTIVE : IM_LIST_ROW_IDLE,
                        )}
                        onClick={() => onSelect(conversation.id)}
                      >
                        {selected ? <span className={IM_LIST_ROW_MARKER} /> : null}
                        <span
                          className={cn(
                            "flex size-10 shrink-0 items-center justify-center text-ui-xs font-medium",
                            conversation.kind === "dm" ? "rounded-full" : "rounded-xl",
                            avatarTone(conversation.id),
                          )}
                        >
                          {initialsOf(title)}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex items-baseline gap-2">
                            {preference.pinned ? (
                              <PinIcon className="size-3 shrink-0 self-center text-muted-foreground" />
                            ) : null}
                            <span className={cn(IM_LIST_NAME, "min-w-0 flex-1")}>{title}</span>
                            <span className={IM_LIST_TIME}>
                              {formatListTime(conversation.updatedAt, now, timeLabels)}
                            </span>
                          </span>
                          <span className="flex items-center gap-2">
                            <span className={cn(IM_LIST_PREVIEW, "min-w-0 flex-1 text-ui-xs")}>
                              {preview.prefix
                                ? `${preview.prefix === "you:" ? t("im.you") : preview.prefix} ${preview.text}`
                                : preview.text}
                            </span>
                            {/* 静音的会话不报数，只留一个小圆点：要的是"别打扰"，不是"看不到"。 */}
                            {unread > 0 ? (
                              preference.muted ? (
                                <span
                                  data-testid="im-conversation-muted-dot"
                                  className={cn(IM_UNREAD_DOT, "bg-foreground-subtle/70")}
                                />
                              ) : (
                                <span
                                  data-testid="im-conversation-unread"
                                  className={IM_UNREAD_PILL}
                                >
                                  {unread > 99 ? "99+" : unread}
                                </span>
                              )
                            ) : null}
                          </span>
                        </span>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => toggle(conversation.id, "pinned")}>
                        {preference.pinned ? t("im.unpin") : t("im.pin")}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => toggle(conversation.id, "muted")}>
                        {preference.muted ? t("im.unmute") : t("im.mute")}
                      </ContextMenuItem>
                      {unread > 0 ? (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem onSelect={() => onMarkRead(conversation)}>
                            {t("im.markRead")}
                          </ContextMenuItem>
                        </>
                      ) : null}
                    </ContextMenuContent>
                  </ContextMenu>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        data-testid="im-conversation-menu"
                        aria-label={t("im.rowMenu")}
                        className={cn(
                          "absolute top-2 right-2 size-6 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100",
                          preference.muted && "opacity-100",
                        )}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <MoreHorizontalIcon className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem onSelect={() => toggle(conversation.id, "pinned")}>
                        {preference.pinned ? t("im.unpin") : t("im.pin")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => toggle(conversation.id, "muted")}>
                        {preference.muted ? t("im.unmute") : t("im.mute")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {preference.muted ? (
                    <BellOffIcon
                      data-testid="im-conversation-muted-icon"
                      className="pointer-events-none absolute right-9 bottom-3 size-3 text-muted-foreground/70"
                    />
                  ) : null}
                </li>
              );
            }),
          ])
        )}
      </ul>
    </div>
  );
});
