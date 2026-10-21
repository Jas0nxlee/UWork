import { memo } from "react";
import type { ImBookmarkItem } from "@zcode/shared";
import { BookmarkIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  IM_CHROME,
  IM_EMPTY,
  IM_EMPTY_ICON,
  IM_EMPTY_TEXT,
  IM_HEADER,
  IM_HEADER_TITLE,
  IM_LIST_NAME,
  IM_LIST_PADDING,
  IM_LIST_PREVIEW,
  IM_LIST_ROW,
  IM_LIST_ROW_IDLE,
} from "./imChrome.js";
import { avatarTone, formatClockTime, initialsOf, messageBodyText } from "./imPresentation.js";

/**
 * 收藏列表（rail 的第三个入口）。
 *
 * 收藏的语义是"我以后要回到这句话"，所以每条都必须显示**它来自哪个会话**，
 * 并且点一下能跳过去；只列内容不给来路，过两天就不知道这条是在哪说的了。
 */
export const ImBookmarksList = memo(function ImBookmarksList({
  items,
  conversationTitleOf,
  senderNameOf,
  selfUserId,
  onOpen,
}: {
  items: ImBookmarkItem[];
  conversationTitleOf: (item: ImBookmarkItem) => string;
  senderNameOf: (id: string) => string | undefined;
  selfUserId: string | null;
  onOpen: (item: ImBookmarkItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string): string => intl.formatMessage({ id });

  return (
    <div className={cn("flex w-60 shrink-0 flex-col border-r border-border", IM_CHROME)}>
      <header className={IM_HEADER}>
        <span className={IM_HEADER_TITLE}>{t("im.bookmarks")}</span>
        <span className="ml-auto text-ui-2xs text-foreground-subtle">{items.length}</span>
      </header>
      <div className={cn("min-h-0 flex-1 overflow-y-auto py-1", IM_LIST_PADDING)}>
        {items.length === 0 ? (
          <div className={cn(IM_EMPTY, "py-10")}>
            <BookmarkIcon className={IM_EMPTY_ICON} />
            <p className={IM_EMPTY_TEXT}>{t("im.bookmarksEmpty")}</p>
          </div>
        ) : (
          <ul>
            {items.map((item) => {
              const name =
                item.message.senderId === selfUserId
                  ? t("im.you")
                  : (senderNameOf(item.message.senderId) ?? item.message.senderId);
              return (
                <li key={item.message.id}>
                  <button
                    type="button"
                    data-testid="im-bookmark-item"
                    className={cn(IM_LIST_ROW, IM_LIST_ROW_IDLE, "h-auto items-start py-2")}
                    onClick={() => onOpen(item)}
                  >
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-full text-ui-2xs font-medium",
                        avatarTone(item.message.senderId),
                      )}
                    >
                      {initialsOf(name)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-baseline gap-2">
                        <span className={cn(IM_LIST_PREVIEW, "min-w-0 flex-1")}>
                          {conversationTitleOf(item)}
                        </span>
                        <span className="shrink-0 text-ui-2xs text-foreground-subtle tabular-nums">
                          {formatClockTime(item.message.createdAt)}
                        </span>
                      </span>
                      <span className={cn(IM_LIST_NAME, "text-ui-xs font-normal")}>
                        {name}：{messageBodyText(item.message, t, senderNameOf)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
});
